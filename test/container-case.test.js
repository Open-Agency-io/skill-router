import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { createRunner, parseArgs, repoRoot } from "../scripts/container-harness.mjs";
import {
  CLAUDE_MODEL_RE as HOST_CLAUDE_MODEL_RE,
  CLAUDE_MODEL_ALIASES,
  MIN_SECRET_LENGTH as HOST_MIN_SECRET_LENGTH,
  OPENCODE_AUTH_SUPPORTED_PROVIDERS,
  PlanError,
  RUNTIME,
  expectedCaseChain,
  expectedCaseOutcome,
  formatCaseSuccess,
  loadMatrix,
  MODEL_FORMAT_RE as HOST_OPENCODE_MODEL_RE,
  parseCaseReportStdout,
  preflightLiveCases,
  resolveOpenCodeAuthFile,
  validateCaseReport,
} from "../scripts/container-lib.mjs";
import {
  CLAUDE_BUILTIN_PLUGINS,
  CLAUDE_CONTROL_PROMPT,
  CLAUDE_INIT_TOOLS,
  CLAUDE_MODEL_FORMAT_RE,
  CLAUDE_NONE_PROMPT,
  CLAUDE_REGISTER_CONFIG_DIR,
  CLAUDE_RELEASE_SKILL_ID,
  CLAUDE_ROUTER_SKILL_ID,
  CLAUDE_SELECT_PROMPT,
  CLAUDE_STATE_DIR,
  CLAUDE_TOOLS,
  CaseAssertionError,
  FORBIDDEN_HOME_CLAUDE_ENTRIES,
  FORBIDDEN_PROJECT_CLAUDE_ENTRIES,
  MANAGED_POLICY_ABSENT_ENTRIES,
  MANAGED_POLICY_ABSENT_PATHS,
  MANAGED_POLICY_ROOT,
  MIN_SECRET_LENGTH as CONTAINER_MIN_SECRET_LENGTH,
  MODEL_FORMAT_RE as CONTAINER_OPENCODE_MODEL_RE,
  NONE_REQUEST,
  OPENCODE_AUTH_DATA,
  OPENCODE_AUTH_IMPORT,
  OPENCODE_AUTH_LEGACY,
  OPENCODE_SELECT_PROMPT,
  INSTALL_PREFIX,
  OPENCODE_AUTH_MOUNT,
  OVERLONG_NAME_PLACEHOLDER,
  PLUGIN_DIR,
  PLUGIN_MANIFEST_DIR,
  PLUGIN_MANIFEST_ENTRIES,
  PLUGIN_MANIFEST_FILE,
  PLUGIN_MANIFEST_KEYS,
  PLUGIN_NAME,
  PLUGIN_ROOT_ENTRIES,
  PLUGIN_SKILLS_DIR,
  PROJECT_DIR,
  RELEASE_MARKER,
  RELEASE_SKILL_ID,
  REQUEST_PATCH_TOOL,
  REQUEST_WRITE_TOOL,
  ROUTE_DIAGNOSTIC_MAX_EVENTS,
  ROUTE_OUTPUT_MAX_BYTES,
  ROUTER_SKILL_ID,
  ROUTER_TARGET,
  ROUTER_WRAPPER_DIR,
  ROUTER_WRAPPER_FORBIDDEN_ROOTS,
  ROUTER_WRAPPER_PATH,
  SELECT_REQUEST,
  assertClaudeHasNoAuthMount,
  assertClaudeInitContract,
  assertClaudeInstallation,
  assertClaudeLaunchSurfaces,
  assertClaudeLocalRegistration,
  assertNoManagedClaudePolicy,
  assertPluginTreeUnchanged,
  buildFailureReport,
  canonicalSkillId,
  claudeArgv,
  claudeRegistrationOptions,
  claudeRunEnv,
  verifyImmutableRouterWrapper,
  extractRouteOutput,
  inspectClaudeRun,
  inspectOpenCodeProcess,
  inspectOpenCodeRun,
  normalizeOpenCodeEvent,
  normalizeProviderProbeText as CONTAINER_NORMALIZE_PROBE,
  openCodeRunEnv,
  parseClaudeStdout,
  parseManagedRouteCommand,
  parseOpenCodeStdout,
  parseStructuredPatch,
  patchRequestProof,
  pluginTreeManifest,
  preflightRouterExecutable,
  productionClaudeMarketplaceName,
  providerRecognized as CONTAINER_PROVIDER_RECOGNIZED,
  requireClaudeModel,
  requireOpenCodeModel,
  routeOutputDiagnostic,
  routerHarnessFlag,
  ROUTER_WRAPPER_SHA256,
  sanitizeContainerText,
  setupOpenCodeAuth,
  summarizeClaudeEvents,
  summarizeOpenCodeEvents,
  withWrapperPath,
} from "../scripts/container-run-case.mjs";
import { planClaudePlugin, stageClaudePlugin } from "../src/claude.js";
import { buildInstallation, CLAUDE_PLUGINS, claudeIdentity } from "../src/installation.js";
import {
  normalizeProviderProbeText as VERIFY_NORMALIZE_PROBE,
  providerRecognized as VERIFY_PROVIDER_RECOGNIZED,
  verifySystemRipgrep as VERIFY_SYSTEM_RIPGREP,
} from "../scripts/container-verify.mjs";

const manifest = loadMatrix(repoRoot);
const FIXTURES = path.join(repoRoot, "test", "fixtures", "container");

const FILES = {
  v1Select: "opencode-v1-select.json",
  v1None: "opencode-v1-none.json",
  v2Select: "opencode-v2-select.json",
  v2None: "opencode-v2-none.json",
  claudeSelect: "claude-select.json",
  claudeNone: "claude-none.json",
  claudeControl: "claude-control.json",
  v2SelectPatch: "opencode-v2-select-patch.json",
  v2NonePatch: "opencode-v2-none-patch.json",
  v2NoneMetadata: "opencode-v2-none-metadata.json",
  v2NoneContent: "opencode-v2-none-content.json",
};

function fixture(name) {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8"));
}

/** Representative harness stdout: NDJSON (OpenCode also accepts a JSON array). */
function toStdout(events) {
  return events.map((event) => JSON.stringify(event)).join("\n");
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function expectCaseFailure(fn, pattern) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof CaseAssertionError, `expected CaseAssertionError, got ${error?.name}`);
    assert.ok(pattern.test(error.message), `expected ${pattern} in "${error.message}"`);
    return true;
  });
}

/** Input object of the tool_use block with this id (mutated by tests). */
function toolInputOf(events, id) {
  for (const event of events) {
    const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
    const block = blocks.find((entry) => entry?.type === "tool_use" && entry.id === id);
    if (block) return block.input;
  }
  throw new Error(`tool_use ${id} not found in fixture`);
}

/** tool_result block correlated with this tool_use id (mutated by tests). */
function toolResultOf(events, id) {
  for (const event of events) {
    const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
    const block = blocks.find((entry) => entry?.type === "tool_result" && entry.tool_use_id === id);
    if (block) return block;
  }
  throw new Error(`tool_result ${id} not found in fixture`);
}

/* ------------------------------ OpenCode v1/v2 ------------------------------ */

test("v1 select fixture proves the full ordered structural chain", () => {
  const result = inspectOpenCodeRun(toStdout(fixture(FILES.v1Select)), {
    scenario: "select",
    request: SELECT_REQUEST,
  });
  assert.deepEqual(result.chain, expectedCaseChain("opencode-v1", "select"));
  assert.equal(result.sessionCount, 1);
  assert.equal(result.outcome, "select");
  assert.equal(result.skillId, "release");
});

test("v1 none fixture abstains without release load or marker", () => {
  const result = inspectOpenCodeRun(toStdout(fixture(FILES.v1None)), { scenario: "none", request: NONE_REQUEST });
  assert.deepEqual(result.chain, expectedCaseChain("opencode-v1", "none"));
  assert.equal(result.outcome, "none");
  assert.equal(result.skillId, null);
});

test("nonzero OpenCode runs surface structural stream failures before process status", () => {
  const options = { scenario: "select", request: SELECT_REQUEST };
  expectCaseFailure(
    () => inspectOpenCodeProcess({ output: toStdout(fixture(FILES.v1Select)), status: 1 }, options),
    /opencode exited with status 1/,
  );

  const failed = clone(fixture(FILES.v1Select));
  const router = failed.find(
    (event) => event.part?.tool === "skill" && event.part?.state?.input?.name === "skill-router",
  );
  assert.ok(router, "router skill fixture event exists");
  router.part.state.status = "error";
  expectCaseFailure(
    () => inspectOpenCodeProcess({ output: toStdout(failed), status: 1 }, options),
    /router skill load failed/,
  );
});

test("v2 fixtures normalize id/bash/part.status shapes and prove the same chains", () => {
  const raw = fixture(FILES.v2Select);
  const normalized = raw.map(normalizeOpenCodeEvent).filter(Boolean);
  const skillEvents = normalized.filter((event) => event.tool === "skill");
  assert.ok(skillEvents.length >= 2, "v2 skill events present");
  assert.ok(skillEvents.every((event) => typeof event.input?.id === "string"), "v2 skill input uses `id`");
  assert.ok(skillEvents.every((event) => event.status === "completed"), "v2 status comes from part.status");
  const bash = normalized.find((event) => event.tool === "bash");
  assert.ok(bash && typeof bash.input.command === "string", "v2 shell tool is `bash`");

  const select = inspectOpenCodeRun(toStdout(raw), { scenario: "select", request: SELECT_REQUEST });
  assert.deepEqual(select.chain, expectedCaseChain("opencode-v2", "select"));
  assert.equal(select.outcome, "select");

  const none = inspectOpenCodeRun(toStdout(fixture(FILES.v2None)), { scenario: "none", request: NONE_REQUEST });
  assert.deepEqual(none.chain, expectedCaseChain("opencode-v2", "none"));
  assert.equal(none.outcome, "none");
});

test("OpenCode stdout accepts both NDJSON and a JSON array", () => {
  const events = fixture(FILES.v1Select);
  assert.equal(parseOpenCodeStdout(toStdout(events)).length, events.length);
  assert.equal(parseOpenCodeStdout(JSON.stringify(events)).length, events.length);
});

test("marker-only output is never accepted as proof (OpenCode and Claude)", () => {
  expectCaseFailure(
    () =>
      inspectOpenCodeRun(
        toStdout([{ type: "text", sessionID: "ses_markeronly", part: { type: "text", text: `done ${RELEASE_MARKER}` } }]),
        { scenario: "select", request: SELECT_REQUEST },
      ),
    /router skill was never loaded/,
  );

  const init = clone(fixture(FILES.claudeSelect)[0]);
  const markerOnly = [init, { type: "assistant", session_id: init.session_id, message: { content: [{ type: "text", text: RELEASE_MARKER }] } }, { type: "result", subtype: "success", is_error: false, session_id: init.session_id }];
  expectCaseFailure(() => inspectClaudeRun(toStdout(markerOnly), { scenario: "select", request: SELECT_REQUEST }), /router skill was never loaded with a successful tool_result/);
});

test("wrong ordering is rejected: release/marker must follow the route result", () => {
  const reordered = clone(fixture(FILES.v1Select));
  const releaseIndex = reordered.findIndex((event) => event.part?.tool === "skill" && event.part?.state?.input?.name === "release");
  const [release] = reordered.splice(releaseIndex, 1);
  reordered.splice(2, 0, release); // release before the route command
  expectCaseFailure(
    () => inspectOpenCodeRun(toStdout(reordered), { scenario: "select", request: SELECT_REQUEST }),
    /selected release skill was never loaded after the route result/,
  );

  const claudeReordered = clone(fixture(FILES.claudeSelect));
  const markerIndex = claudeReordered.findIndex((event) =>
    Array.isArray(event.message?.content) && event.message.content.some((block) => block.type === "text"),
  );
  const releaseUseIndex = claudeReordered.findIndex((event) =>
    Array.isArray(event.message?.content) && event.message.content.some((block) => block.type === "tool_use" && block.name === "Skill" && block.input?.skill === CLAUDE_RELEASE_SKILL_ID),
  );
  assert.ok(markerIndex > releaseUseIndex, "fixture baseline has the marker last");
  const [marker] = claudeReordered.splice(markerIndex, 1);
  claudeReordered.splice(releaseUseIndex, 0, marker); // marker before the release load
  expectCaseFailure(
    () => inspectClaudeRun(toStdout(claudeReordered), { scenario: "select", request: SELECT_REQUEST }),
    /marker surfaced before the selected skill loaded/,
  );
});

test("failed tools are rejected (route error, router load error, failed route result)", () => {
  const routeFailed = clone(fixture(FILES.v1Select));
  const route = routeFailed.find((event) => event.part?.state?.input?.command?.includes("skill-router route"));
  route.part.state.status = "error";
  expectCaseFailure(() => inspectOpenCodeRun(toStdout(routeFailed), { scenario: "select", request: SELECT_REQUEST }), /route command failed/);

  const routerFailed = clone(fixture(FILES.v1Select));
  const router = routerFailed.find((event) => event.part?.tool === "skill" && event.part?.state?.input?.name === "skill-router");
  router.part.state.status = "error";
  expectCaseFailure(() => inspectOpenCodeRun(toStdout(routerFailed), { scenario: "select", request: SELECT_REQUEST }), /router skill load failed/);

  const claudeRouteFailed = clone(fixture(FILES.claudeSelect));
  const bashResult = claudeRouteFailed.find((event) =>
    Array.isArray(event.message?.content) && event.message.content.some((block) => block.type === "tool_result" && block.content.includes('"outcome"')),
  );
  bashResult.message.content[0].is_error = true;
  expectCaseFailure(
    () => inspectClaudeRun(toStdout(claudeRouteFailed), { scenario: "select", request: SELECT_REQUEST }),
    /no route tool_result parsed as router JSON/,
  );
});

test("multiple or reused session ids are rejected in both harnesses", () => {
  const twoSessions = clone(fixture(FILES.v1Select));
  twoSessions[twoSessions.length - 1].sessionID = "ses_other_session";
  expectCaseFailure(
    () => inspectOpenCodeRun(toStdout(twoSessions), { scenario: "select", request: SELECT_REQUEST }),
    /2 distinct sessions/,
  );

  const claudeTwoSessions = clone(fixture(FILES.claudeNone));
  claudeTwoSessions[claudeTwoSessions.length - 1].session_id = "99999999-8888-7777-6666-555555555555";
  expectCaseFailure(
    () => inspectClaudeRun(toStdout(claudeTwoSessions), { scenario: "none", request: NONE_REQUEST }),
    /2 distinct sessions/,
  );
});

test("mismatched request tokens are rejected in both harnesses", () => {
  const opencodeMismatch = clone(fixture(FILES.v1Select));
  const write = opencodeMismatch.find((event) => event.part?.state?.input?.path?.includes("/.skill-router-requests/"));
  write.part.state.input.path = "/workspace/project/.skill-router-requests/00000000000000000000000000000000.txt";
  expectCaseFailure(
    () => inspectOpenCodeRun(toStdout(opencodeMismatch), { scenario: "select", request: SELECT_REQUEST }),
    /written request token did not match the route command token/,
  );

  const claudeMismatch = clone(fixture(FILES.claudeSelect));
  const bash = claudeMismatch.find((event) =>
    Array.isArray(event.message?.content) && event.message.content.some((block) => block.type === "tool_use" && block.name === "Bash"),
  );
  bash.message.content[0].input.command = "skill-router route --json --request-token ffffffff00000000ffffffff00000000";
  expectCaseFailure(
    () => inspectClaudeRun(toStdout(claudeMismatch), { scenario: "select", request: SELECT_REQUEST }),
    /route command token did not match the written request token/,
  );
});

test("unsafe route commands are rejected: raw request interpolation or missing token", () => {
  const interpolated = clone(fixture(FILES.v2Select));
  const route = interpolated.find((event) => {
    const input = event.part?.state?.input ?? event.part?.input;
    return typeof input?.command === "string" && input.command.includes("skill-router route");
  });
  assert.ok(route, "v2 fixture route found (nested part.state.input)");
  assert.ok(route.part.state?.input?.command, "v2 fixture route uses the nested part.state shape");
  route.part.state.input.command = `skill-router route --json --request-token ffeeddccbbaa99887766554433221100 "${SELECT_REQUEST}"`;
  expectCaseFailure(
    () => inspectOpenCodeRun(toStdout(interpolated), { scenario: "select", request: SELECT_REQUEST }),
    /interpolated the request text/,
  );

  const noToken = clone(fixture(FILES.v1Select));
  noToken.find((event) => event.part?.state?.input?.command?.includes("skill-router route")).part.state.input.command =
    `skill-router route --json --request "${SELECT_REQUEST}"`;
  expectCaseFailure(
    () => inspectOpenCodeRun(toStdout(noToken), { scenario: "select", request: SELECT_REQUEST }),
    /did not use a 32-hex --request-token/,
  );

  const claudeInterpolated = clone(fixture(FILES.claudeSelect));
  claudeInterpolated.find((event) =>
    Array.isArray(event.message?.content) && event.message.content.some((block) => block.type === "tool_use" && block.name === "Bash"),
  ).message.content[0].input.command = `skill-router route --json --request-token 0123456789abcdef0123456789abcdef "${SELECT_REQUEST}"`;
  expectCaseFailure(
    () => inspectClaudeRun(toStdout(claudeInterpolated), { scenario: "select", request: SELECT_REQUEST }),
    /interpolated the request text/,
  );
});

test("release loads or markers on none/control are rejected", () => {
  const releaseOnNone = clone(fixture(FILES.v1None));
  const routeIndex = releaseOnNone.findIndex((event) => event.part?.state?.input?.command?.includes("skill-router route"));
  releaseOnNone.splice(routeIndex + 1, 0, {
    type: "tool_use",
    sessionID: releaseOnNone[0].sessionID,
    part: { type: "tool", tool: "skill", state: { status: "completed", input: { name: "release" }, output: "loaded" } },
  });
  expectCaseFailure(
    () => inspectOpenCodeRun(toStdout(releaseOnNone), { scenario: "none", request: NONE_REQUEST }),
    /release skill was loaded in a none scenario/,
  );

  const markerOnNone = clone(fixture(FILES.v2None));
  markerOnNone.push({ type: "text", sessionID: markerOnNone[0].sessionID, part: { type: "text", text: RELEASE_MARKER } });
  expectCaseFailure(
    () => inspectOpenCodeRun(toStdout(markerOnNone), { scenario: "none", request: NONE_REQUEST }),
    /none scenario surfaced the hidden marker/,
  );

  const releaseOnClaudeNone = clone(fixture(FILES.claudeNone));
  releaseOnClaudeNone.splice(releaseOnClaudeNone.length - 1, 0,
    { type: "assistant", session_id: releaseOnClaudeNone[0].session_id, message: { content: [{ type: "tool_use", id: "t9", name: "Skill", input: { skill: "release" } }] } },
    { type: "user", session_id: releaseOnClaudeNone[0].session_id, message: { content: [{ type: "tool_result", tool_use_id: "t9", content: "loaded" }] } },
  );
  expectCaseFailure(
    () => inspectClaudeRun(toStdout(releaseOnClaudeNone), { scenario: "none", request: NONE_REQUEST }),
    /release skill was loaded in a none scenario/,
  );

  const releaseOnControl = clone(fixture(FILES.claudeControl));
  releaseOnControl.splice(releaseOnControl.length - 1, 0,
    { type: "assistant", session_id: releaseOnControl[0].session_id, message: { content: [{ type: "tool_use", id: "t9", name: "Skill", input: { skill: "release" } }] } },
    { type: "user", session_id: releaseOnControl[0].session_id, message: { content: [{ type: "tool_result", tool_use_id: "t9", content: "loaded" }] } },
  );
  expectCaseFailure(
    () => inspectClaudeRun(toStdout(releaseOnControl), { scenario: "control" }),
    /control loaded the release skill/,
  );

  const markerOnControl = clone(fixture(FILES.claudeControl));
  markerOnControl.push({ type: "assistant", session_id: markerOnControl[0].session_id, message: { content: [{ type: "text", text: `hidden ${RELEASE_MARKER}` }] } });
  expectCaseFailure(() => inspectClaudeRun(toStdout(markerOnControl), { scenario: "control" }), /control surfaced the hidden marker/);
});

/* ------------------------------- Claude control ----------------------------- */

test("claude control proves the router is unavailable and never routes", () => {
  const result = inspectClaudeRun(toStdout(fixture(FILES.claudeControl)), { scenario: "control" });
  assert.deepEqual(result.chain, expectedCaseChain("claude", "control"));
  assert.equal(result.outcome, "unavailable");
  assert.equal(result.skillId, null);
  assert.equal(result.sessionCount, 1);
});

test("claude control without any structural proof is rejected", () => {
  const events = clone(fixture(FILES.claudeControl));
  // Strip both proofs: no skills inventory and no Skill attempt.
  delete events[0].skills;
  delete events[0].slash_commands;
  const withoutProof = events.filter((event) => {
    const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
    return !blocks.some(
      (block) =>
        block.type === "tool_use" &&
        block.name === "Skill" &&
        block.input?.skill === CLAUDE_ROUTER_SKILL_ID,
    );
  });
  expectCaseFailure(() => inspectClaudeRun(toStdout(withoutProof), { scenario: "control" }), /no structural proof that the router skill is unavailable/);
});

test("claude select/none fixtures prove the routed ordered chain", () => {
  const select = inspectClaudeRun(toStdout(fixture(FILES.claudeSelect)), { scenario: "select", request: SELECT_REQUEST });
  assert.deepEqual(select.chain, expectedCaseChain("claude", "select"));
  assert.equal(select.outcome, "select");
  assert.equal(select.skillId, "release");

  const none = inspectClaudeRun(toStdout(fixture(FILES.claudeNone)), { scenario: "none", request: NONE_REQUEST });
  assert.deepEqual(none.chain, expectedCaseChain("claude", "none"));
  assert.equal(none.outcome, "none");
  assert.equal(none.skillId, null);
});

test("claude routed runs use successful Skill results as authoritative plugin proof", () => {
  const events = clone(fixture(FILES.claudeSelect));
  events[0].skills = { "update-config": ["builtin only"] };
  const result = inspectClaudeRun(toStdout(events), { scenario: "select", request: SELECT_REQUEST });
  assert.deepEqual(result.chain, expectedCaseChain("claude", "select"));

  const failed = clone(events);
  const routerResult = failed.find((event) =>
    event.message?.content?.some((block) => block.type === "tool_result" && block.tool_use_id === "t1"),
  );
  assert.ok(routerResult, "router tool_result fixture exists");
  routerResult.message.content.find((block) => block.tool_use_id === "t1").is_error = true;
  expectCaseFailure(
    () => inspectClaudeRun(toStdout(failed), { scenario: "select", request: SELECT_REQUEST }),
    /router skill was never loaded with a successful tool_result/,
  );
});

/* --------------------------------- parsing ---------------------------------- */

test("malformed harness streams fail structurally without echoing content", () => {
  expectCaseFailure(() => parseOpenCodeStdout("not json at all"), /was not valid JSON/);
  expectCaseFailure(() => parseOpenCodeStdout(""), /no event stream/);
  expectCaseFailure(() => parseOpenCodeStdout('{"type":"text"}\nnot-json-line'), /line 2 was not valid JSON/);
  expectCaseFailure(() => parseClaudeStdout("RAW OUTPUT WITH sk-ant-secret-0123456789"), /was not valid JSON/);
  expectCaseFailure(() => parseClaudeStdout(""), /no stream events/);
});

test("in-container sanitizer strips secrets, tokens, uuids, and container paths", () => {
  process.env.SANITIZER_TEST_SECRET = "sk-ant-sanitizer-test-0123456789";
  try {
    const cleaned = sanitizeContainerText(
      `failed ${process.env.SANITIZER_TEST_SECRET} at /workspace/project/.skill-router-requests/` +
        "aabbccddeeff00112233445566778899.txt session 11111111-2222-3333-4444-555555555555 in /home/node/.claude",
    );
    assert.ok(!cleaned.includes("sk-ant-sanitizer-test-0123456789"), "credential value redacted");
    assert.ok(cleaned.includes("[redacted"), "credential placeholder present");
    assert.ok(!cleaned.includes("/workspace/"), "container workspace path stripped");
    assert.ok(!cleaned.includes("/home/node"), "container home path stripped");
    assert.ok(cleaned.includes("[request-token]"), "request token redacted");
    assert.ok(cleaned.includes("[uuid]"), "session uuid redacted");
  } finally {
    delete process.env.SANITIZER_TEST_SECRET;
  }
});

/* --------------------------- host-side report contract ---------------------- */

function validReport(overrides = {}) {
  return {
    ok: true,
    case: "opencode-v1-select",
    harness: "opencode-v1",
    scenario: "select",
    container: "skill-router-case-opencode-v1-select-run1",
    artifactSha256: "a".repeat(64),
    sessionCount: 1,
    outcome: "select",
    skillId: "release",
    chain: expectedCaseChain("opencode-v1", "select"),
    ...overrides,
  };
}

const descriptor = { id: "opencode-v1-select", harness: "opencode-v1", scenario: "select" };
const containerName = "skill-router-case-opencode-v1-select-run1";
const lockedHash = "a".repeat(64);
const validate = (report) =>
  validateCaseReport({ report, caseDescriptor: descriptor, containerName, artifactSha256: lockedHash });

test("validateCaseReport accepts a fully valid report and rejects every drifted field", () => {
  const summary = validate(validReport());
  assert.equal(summary.outcome, "select");
  assert.equal(summary.skillId, "release");
  assert.equal(summary.sessionCount, 1);
  assert.deepEqual(summary.chain, expectedCaseChain("opencode-v1", "select"));

  assert.throws(() => validate(validReport({ sessionCount: 2 })), /sessionCount must be exactly 1/);
  assert.throws(() => validate(validReport({ artifactSha256: "b".repeat(64) })), /artifact sha256 does not match/);
  assert.throws(() => validate(validReport({ container: "skill-router-case-other-run1" })), /container mismatch/);
  assert.throws(() => validate(validReport({ harness: "opencode-v2" })), /harness mismatch/);
  assert.throws(() => validate(validReport({ scenario: "none" })), /scenario mismatch/);
  assert.throws(() => validate(validReport({ outcome: "none" })), /outcome mismatch/);
  assert.throws(() => validate(validReport({ skillId: null })), /skillId mismatch/);
  assert.throws(() => validate(validReport({ chain: ["router-skill-loaded", "route-result", "route-invoked", "release-skill-loaded", "marker-emitted"] })), /chain mismatch/);
  assert.throws(() => validate(validReport({ extra: "smuggled" })), /fields drifted/);
  const missingField = validReport();
  delete missingField.skillId;
  assert.throws(() => validate(missingField), /fields drifted/);
});

test("validateCaseReport surfaces container failure reports with their stage", () => {
  const failure = {
    ok: false,
    case: "opencode-v1-select",
    harness: "opencode-v1",
    scenario: "select",
    stage: "inspect",
    error: "route command interpolated the request text (unsafe shell transport)",
    events: [{ kind: "tool_use", tool: "shell", status: "completed" }],
    sessionCount: 1,
  };
  assert.throws(
    () => validate(failure),
    (error) => {
      assert.ok(error instanceof PlanError);
      assert.ok(/case opencode-v1-select failed in stage inspect: route command interpolated/.test(error.message));
      assert.match(error.message, /events=\[tool_use:shell:completed\]/);
      assert.ok(error.caseReport && error.caseReport.ok === false, "full failure report attached programmatically");
      return true;
    },
  );
  // A bogus stage label cannot smuggle arbitrary text through the stage field.
  assert.throws(() => validate({ ...failure, stage: "<script>alert(1)</script>" }), /failed in stage unknown/);
  assert.throws(
    () => validate({ ...failure, events: [{ kind: "/secret/path", tool: "write", status: "completed" }] }),
    (error) => !error.message.includes("/secret/path") && error.message.includes("events=[write:completed]"),
  );
});

test("parseCaseReportStdout requires exactly one JSON object line", () => {
  const report = validReport();
  assert.deepEqual(parseCaseReportStdout(`${JSON.stringify(report)}\n`), report);
  assert.throws(() => parseCaseReportStdout(""), /emitted 0 stdout line\(s\)/);
  assert.throws(() => parseCaseReportStdout(`${JSON.stringify(report)}\n${JSON.stringify(report)}`), /emitted 2 stdout line\(s\)/);
  assert.throws(() => parseCaseReportStdout("just words with sk-ant-abcdef123456\n"), /was not a JSON report/);
  assert.throws(() => parseCaseReportStdout(`${JSON.stringify([report])}\n`), /was not a JSON object/);
});

test("formatCaseSuccess prints a concise sanitized summary", () => {
  const summary = validate(validReport());
  const line = formatCaseSuccess(summary);
  assert.ok(line.startsWith("case opencode-v1-select: ok outcome=select skill=release sessions=1 "));
  assert.ok(line.includes("container=skill-router-case-opencode-v1-select-run1"));
  assert.ok(line.includes(`chain=[${expectedCaseChain("opencode-v1", "select").join(",")}]`));
});

/* --------------------------------- preflight -------------------------------- */

test("preflight scopes model requirements to the selected cases", () => {
  const claudeOnly = preflightLiveCases({
    manifest,
    env: { SKILL_ROUTER_CLAUDE_MODEL: "sonnet", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-live-0123456789abcdef" },
    caseIds: ["claude-control"],
    selectedSecretNames: ["CLAUDE_CODE_OAUTH_TOKEN"],
  });
  assert.equal(claudeOnly.models.claude, "sonnet");
  assert.equal(claudeOnly.models.opencode, undefined, "no OpenCode model required for a Claude-only selection");
  assert.deepEqual(claudeOnly.cases, ["claude-control"]);

  assert.throws(
    () =>
      preflightLiveCases({
        manifest,
        env: { SKILL_ROUTER_OPENCODE_MODEL: "provider/model-id", OPENAI_API_KEY: "sk-openai-live-0123456789" },
        caseIds: ["opencode-v1-select", "claude-control"],
        selectedSecretNames: ["OPENAI_API_KEY"],
      }),
    (error) => error instanceof PlanError && /SKILL_ROUTER_CLAUDE_MODEL is required/.test(error.message),
    "mixed selection still requires the Claude model",
  );

  assert.throws(
    () => preflightLiveCases({ manifest, env: {}, caseIds: ["nope"], selectedSecretNames: [] }),
    /unknown case id/,
  );

  assert.throws(
    () =>
      preflightLiveCases({
        manifest,
        env: { SKILL_ROUTER_OPENCODE_MODEL: "not-a-model", SKILL_ROUTER_CLAUDE_MODEL: "anthropic/x", ANTHROPIC_API_KEY: "sk-ant-live-0123456789abcdef", OPENAI_API_KEY: "sk-openai-live-0123456789" },
        selectedSecretNames: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
      }),
    (error) => error instanceof PlanError && /provider\/model format/.test(error.message),
    "model envs must use provider/model format",
  );
});

test("expected chains and outcomes are the independent host-side contract", () => {
  assert.deepEqual(expectedCaseChain("opencode-v1", "select"), ["router-skill-loaded", "request-token-written", "route-invoked", "route-result", "release-skill-loaded", "marker-emitted"]);
  assert.deepEqual(expectedCaseChain("opencode-v2", "none"), ["router-skill-loaded", "request-token-written", "route-invoked", "route-result", "abstained"]);
  assert.deepEqual(expectedCaseChain("claude", "select"), ["router-skill-loaded", "request-token-written", "route-invoked", "route-result", "release-skill-loaded", "marker-emitted"]);
  assert.deepEqual(expectedCaseChain("claude", "none"), ["router-skill-loaded", "request-token-written", "route-invoked", "route-result", "abstained"]);
  assert.deepEqual(expectedCaseChain("claude", "control"), ["router-unavailable"]);
  assert.deepEqual(expectedCaseOutcome("select"), { outcome: "select", skillId: "release" });
  assert.deepEqual(expectedCaseOutcome("none"), { outcome: "none", skillId: null });
  assert.deepEqual(expectedCaseOutcome("control"), { outcome: "unavailable", skillId: null });
  assert.throws(() => expectedCaseOutcome("bogus"), /unknown case scenario/);
});

/* ----------------------- Gate 2 remediation coverage ------------------------ */

test("claude argv exposes exactly Skill,Write,Bash and the plugin only for select/none", () => {
  const select = claudeArgv({ model: "sonnet", pluginDir: PLUGIN_DIR });
  assert.deepEqual(
    select.slice(0, 6),
    ["-p", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--model"],
  );
  assert.deepEqual(select.slice(6, 11), ["sonnet", "--permission-mode", "dontAsk", "--permission-prompts", "none"]);
  assert.deepEqual(
    select.slice(11, 13),
    ["--restricted", "--strict-mcp-config"],
    "non-bare isolation hardening flags are part of the exact argv",
  );
  assert.deepEqual(select.slice(13, 15), ["--tools", CLAUDE_TOOLS], "true exposed-tool allowlist");
  assert.equal(CLAUDE_TOOLS, "Skill,Write,Bash");
  assert.equal(select[select.indexOf("--allowedTools") + 1], "Skill,Write,Bash(skill-router route:*)");
  const disallowed = select[select.indexOf("--disallowedTools") + 1];
  assert.ok(disallowed.includes("WebFetch"), "disallow rules retained");
  assert.ok(
    disallowed.split(",").includes("mcp__*"),
    "every MCP tool is defensively denied on top of --strict-mcp-config",
  );
  assert.deepEqual(select.slice(-2), ["--plugin-dir", PLUGIN_DIR], "generated plugin exposed as an inert plugin directory");
  assert.equal(PLUGIN_DIR, "/workspace/project/.skill-router/claude/plugins/openagency-skill-router");
  assert.equal(PLUGIN_DIR, path.join(CLAUDE_STATE_DIR, "plugins", PLUGIN_NAME));
  assert.equal(PLUGIN_SKILLS_DIR, path.join(PLUGIN_DIR, "skills"));
  assert.equal(PLUGIN_MANIFEST_DIR, path.join(PLUGIN_DIR, ".claude-plugin"));
  assert.equal(PLUGIN_MANIFEST_FILE, path.join(PLUGIN_MANIFEST_DIR, "plugin.json"));
  assert.deepEqual([...PLUGIN_ROOT_ENTRIES], [".claude-plugin", "skills"]);
  assert.deepEqual([...PLUGIN_MANIFEST_ENTRIES], ["plugin.json"]);
  assert.ok(!select.includes("--add-dir"), "--add-dir is no longer used to expose the plugin");
  assert.ok(!select.includes("--settings") && !select.includes("--setting-sources"), "no settings surface is introduced");
  assert.ok(!select.includes("--mcp-config"), "no MCP config file is ever supplied");

  // Non-bare is mandatory for setup-token auth, and no interactive/ambiguous
  // permission surface may remain.
  assert.ok(!select.includes("--bare"), "bare mode would ignore CLAUDE_CODE_OAUTH_TOKEN");
  assert.ok(!select.includes("default"), "no ambiguous default permission mode");
  assert.equal(select[select.indexOf("--permission-mode") + 1], "dontAsk");
  assert.equal(select[select.indexOf("--permission-prompts") + 1], "none");
  assert.equal(select[select.indexOf("--restricted") + 1], "--strict-mcp-config", "both hardening flags are adjacent and present");
  assert.equal(select.filter((token) => token === "--restricted").length, 1, "--restricted appears exactly once");
  assert.equal(select.filter((token) => token === "--strict-mcp-config").length, 1, "--strict-mcp-config appears exactly once");
  assert.ok(select.includes("--no-session-persistence"), "session persistence stays disabled");

  const control = claudeArgv({ model: "sonnet", pluginDir: null });
  assert.deepEqual(control, select.slice(0, -2), "control differs only by the missing --plugin-dir");
  assert.ok(!control.includes("--plugin-dir"), "control must never receive the plugin directory");
  assert.ok(!control.includes("--add-dir"), "control must never receive a plugin directory either");
  assert.ok(control.includes("--tools"), "control still exposes Skill so unavailability is observable");
  assert.deepEqual(control.filter((token) => token === "--plugin-dir").length, 0);

  const controlModelled = claudeArgv({ model: "claude-sonnet-4-5", pluginDir: null });
  assert.ok(controlModelled.includes("--model") && controlModelled.includes("claude-sonnet-4-5"), "model passed through unchanged");
  assert.ok(!controlModelled.includes("--plugin-dir"), "control never receives the plugin directory, model aside");

  // No flattened-only assumption: exact argv has no project-local .claude path.
  assert.ok(!select.join(" ").includes("/workspace/project/.claude"), "the plugin is never the project directory");
  assert.ok(!select.join(" ").includes("ANTHROPIC_API_KEY"), "no API-key auth surface in argv");
  assert.ok(!select.join(" ").includes("CLAUDE_CODE_OAUTH_TOKEN"), "the token is never an argv value");
});

test("router initialization always passes an explicit harness and isolates Claude registration", () => {
  assert.equal(routerHarnessFlag("claude"), "claude");
  assert.equal(routerHarnessFlag("opencode-v1"), "opencode");
  assert.equal(routerHarnessFlag("opencode-v2"), "opencode");

  const registration = claudeRegistrationOptions();
  // The router process runs in the router root, and the adapter passes that
  // root as cwd to every Claude command, so local scope lands in the project.
  assert.equal(registration.cwd, undefined, "no scratch cwd: commands run with cwd = the router root");
  assert.equal(registration.env.PWD, PROJECT_DIR, "the router targets the project root");
  assert.equal(registration.env.CLAUDE_CONFIG_DIR, CLAUDE_REGISTER_CONFIG_DIR, "the CLI cache stays out of HOME");
  assert.equal(registration.env.SKILL_ROUTER_HOME, process.env.HOME ?? "/home/node", "router HOME is unchanged");
  assert.equal(registration.env.DISABLE_TELEMETRY, "1", "registration is telemetry-free");
  assert.equal(
    registration.env.PATH,
    withWrapperPath(process.env).PATH,
    "registration resolves the immutable wrapper exactly like every other router child",
  );
  assert.ok(
    !String(registration.env.CLAUDE_CONFIG_DIR).startsWith(PROJECT_DIR),
    "the Claude config root is never project-local",
  );
  assert.ok(
    !String(registration.env.CLAUDE_CONFIG_DIR).startsWith(path.join(process.env.HOME ?? "/home/node", ".claude")),
    "the Claude config root is never the container HOME config",
  );
});

test("the project Claude registration surface is exact, regular, and scoped", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "skill-router-claude-registration-"));
  try {
    const projectDir = path.join(root, "project");
    mkdirSync(projectDir, { recursive: true });
    expectCaseFailure(() => assertClaudeLocalRegistration({ projectDir }), /registration directory is missing/);

    const declare = (document) => {
      mkdirSync(path.join(projectDir, ".claude"), { recursive: true });
      writeFileSync(path.join(projectDir, ".claude", "settings.local.json"), `${JSON.stringify(document)}\n`);
    };
    declare({ extraKnownMarketplaces: { "skill-router-abc": { source: { source: "directory", path: "/x" } } } });
    assert.equal(
      assertClaudeLocalRegistration({ projectDir, marketplace: "skill-router-abc" }),
      path.join(projectDir, ".claude", "settings.local.json"),
      "the exact surface is accepted and its path returned",
    );
    expectCaseFailure(
      () => assertClaudeLocalRegistration({ projectDir, marketplace: "skill-router-other" }),
      /does not declare the expected marketplace/,
    );

    writeFileSync(path.join(projectDir, ".claude", "extra.json"), "{}\n");
    expectCaseFailure(
      () => assertClaudeLocalRegistration({ projectDir }),
      /must carry exactly settings\.local\.json/,
    );
    rmSync(path.join(projectDir, ".claude", "extra.json"), { force: true });

    writeFileSync(path.join(projectDir, ".claude", "settings.local.json"), "{ not json");
    expectCaseFailure(() => assertClaudeLocalRegistration({ projectDir }), /not valid JSON/);

    declare({ unrelated: true });
    expectCaseFailure(() => assertClaudeLocalRegistration({ projectDir }), /no marketplace declaration/);

    declare({ extraKnownMarketplaces: { "skill-router-abc": { source: { source: "directory", path: "/x" } } } });
    rmSync(path.join(projectDir, ".claude", "settings.local.json"));
    symlinkSync(path.join(root, "elsewhere.json"), path.join(projectDir, ".claude", "settings.local.json"));
    writeFileSync(path.join(root, "elsewhere.json"), "{}\n");
    expectCaseFailure(
      () => assertClaudeLocalRegistration({ projectDir }),
      /must be a regular file/,
      "a symlinked registration file is never accepted",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("production constants resolve lazily so the container can install the artifact first", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "skill-router-production-lazy-"));
  try {
    // A copy of the runner outside the repository: its only local candidate for
    // the production module is the sibling `src/`, which does not exist yet —
    // exactly the container situation at module load.
    const scripts = path.join(root, "scripts");
    mkdirSync(scripts, { recursive: true });
    const copy = path.join(scripts, "run-case.mjs");
    writeFileSync(copy, readFileSync(path.join(repoRoot, "scripts", "container-run-case.mjs")));

    const deferred = await import(pathToFileURL(copy).href);
    assert.equal(deferred.PLUGIN_NAME, null, "the namespace stays unresolved until the artifact is installed");
    assert.equal(deferred.CLAUDE_ROUTER_SKILL_ID, null, "no namespace is baked in at load");
    assert.equal(deferred.PLUGIN_DIR, null, "plugin paths stay unresolved until the artifact is installed");
    assert.equal(deferred.CLAUDE_CONTROL_PROMPT, null, "prompts embedding the namespace stay unresolved");
    assert.equal(typeof deferred.ensureProductionInstallation, "function");

    // The install step completed: the production module is now resolvable and
    // every namespace-derived export is populated from it.
    mkdirSync(path.join(root, "src"), { recursive: true });
    for (const file of ["installation.js", "policy.js"]) {
      copyFileSync(path.join(repoRoot, "src", file), path.join(root, "src", file));
    }
    copyFileSync(path.join(repoRoot, "package.json"), path.join(root, "package.json"));
    const resolved = await deferred.ensureProductionInstallation();
    assert.equal(resolved.CLAUDE_PLUGINS.project, CLAUDE_PLUGINS.project);
    assert.equal(deferred.PLUGIN_NAME, CLAUDE_PLUGINS.project);
    assert.equal(deferred.CLAUDE_ROUTER_SKILL_ID, `${CLAUDE_PLUGINS.project}:skill-router`);
    assert.equal(deferred.CLAUDE_RELEASE_SKILL_ID, `${CLAUDE_PLUGINS.project}:release`);
    assert.equal(deferred.PLUGIN_DIR, path.join("/workspace/project", ".skill-router", "claude", "plugins", deferred.PLUGIN_NAME));
    assert.match(deferred.CLAUDE_CONTROL_PROMPT, new RegExp(`${deferred.PLUGIN_NAME}:skill-router`));
    assert.equal(
      deferred.productionClaudeMarketplaceName("project", "/srv/router/.skill-router"),
      claudeIdentity({ global: false, stateDirectory: "/srv/router/.skill-router" }).marketplace,
    );
    // Resolution is idempotent and the module load path is explicitly conditional.
    assert.equal(await deferred.ensureProductionInstallation(), resolved);
    const source = readFileSync(path.join(repoRoot, "scripts", "container-run-case.mjs"), "utf8");
    assert.ok(
      source.includes("if (productionSourceAvailable()) await ensureProductionInstallation();"),
      "host-side resolution is conditional on a production source existing at load",
    );
    assert.ok(source.includes("export let PLUGIN_NAME"), "the namespace is never a load-time literal");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("claude model validation accepts aliases/Anthropic ids and rejects OpenCode syntax", () => {
  const base = { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-live-0123456789abcdef" };
  for (const model of ["sonnet", "opus", "haiku", "claude-sonnet-4-5", "claude-3-5-haiku-20241022", "claude-opus-4-1-20250805"]) {
    const result = preflightLiveCases({
      manifest,
      env: { ...base, SKILL_ROUTER_CLAUDE_MODEL: model },
      caseIds: ["claude-control"],
      selectedSecretNames: ["CLAUDE_CODE_OAUTH_TOKEN"],
    });
    assert.equal(result.models.claude, model, `alias/id accepted: ${model}`);
  }
  for (const bad of ["anthropic/claude-sonnet-4-5", "openai/gpt-5", "Sonnet", "claude", "provider/model"]) {
    assert.throws(
      () =>
        preflightLiveCases({
          manifest,
          env: { ...base, SKILL_ROUTER_CLAUDE_MODEL: bad },
          caseIds: ["claude-control"],
          selectedSecretNames: ["CLAUDE_CODE_OAUTH_TOKEN"],
        }),
      (error) =>
        error instanceof PlanError &&
        (/not OpenCode provider\/model syntax/.test(error.message) || /must be a Claude Code alias/.test(error.message)),
      `claude model rejected: ${bad}`,
    );
  }
});

test("OpenCode requires a completed write-tool request file with exact path/content/token/order", () => {
  const writeOf = (events) => events.find((event) => String(event.part?.state?.input?.path ?? "").includes("/.skill-router-requests/"));

  // missing write
  const missing = clone(fixture(FILES.v1Select));
  missing.splice(missing.indexOf(writeOf(missing)), 1);
  expectCaseFailure(() => inspectOpenCodeRun(toStdout(missing), { scenario: "select", request: SELECT_REQUEST }), /request file was never written/);

  // failed (non-completed) write
  const failed = clone(fixture(FILES.v1Select));
  writeOf(failed).part.state.status = "error";
  expectCaseFailure(() => inspectOpenCodeRun(toStdout(failed), { scenario: "select", request: SELECT_REQUEST }), /request file write did not complete \(status error\)/);

  // wrong tool (never bash/shell)
  const wrongTool = clone(fixture(FILES.v1Select));
  writeOf(wrongTool).part.tool = "bash";
  expectCaseFailure(
    () => inspectOpenCodeRun(toStdout(wrongTool), { scenario: "select", request: SELECT_REQUEST }),
    /request file was written by tool "bash" instead of a filesystem write\/patch tool/,
  );

  // A read-only observation of the request path before the real write is not a
  // writer and must not mask the later completed write event.
  const readBeforeWrite = clone(fixture(FILES.v1Select));
  const realWrite = writeOf(readBeforeWrite);
  const readEvent = clone(realWrite);
  readEvent.part.tool = "read";
  readEvent.part.state.input = { path: realWrite.part.state.input.path };
  readEvent.part.state.output = "not included in structural evidence";
  readBeforeWrite.splice(readBeforeWrite.indexOf(realWrite), 0, readEvent);
  assert.equal(
    inspectOpenCodeRun(toStdout(readBeforeWrite), { scenario: "select", request: SELECT_REQUEST }).outcome,
    "select",
  );

  // wrong path (different directory, still inside a stable spool dir)
  const wrongPath = clone(fixture(FILES.v1Select));
  writeOf(wrongPath).part.state.input.path = "/workspace/project/nested/.skill-router-requests/aabbccddeeff00112233445566778899.txt";
  expectCaseFailure(
    () => inspectOpenCodeRun(toStdout(wrongPath), { scenario: "select", request: SELECT_REQUEST }),
    /request file path was not the exact project-local requests path/,
  );

  // wrong path (retired legacy spool directory): still detected, never proof
  const legacyPath = clone(fixture(FILES.v1Select));
  writeOf(legacyPath).part.state.input.path = "/workspace/project/.skill-router/requests/aabbccddeeff00112233445566778899.txt";
  expectCaseFailure(
    () => inspectOpenCodeRun(toStdout(legacyPath), { scenario: "select", request: SELECT_REQUEST }),
    /request file path targeted the retired requests directory/,
  );

  // wrong content (bytes must equal the request exactly)
  const wrongContent = clone(fixture(FILES.v1Select));
  writeOf(wrongContent).part.state.input.content = "prepare and publish a release now";
  expectCaseFailure(
    () => inspectOpenCodeRun(toStdout(wrongContent), { scenario: "select", request: SELECT_REQUEST }),
    /request file content did not match the exact request bytes/,
  );

  // wrong token on the v2 nested shape
  const wrongToken = clone(fixture(FILES.v2Select));
  const v2Write = wrongToken.find((event) => String(event.part?.state?.input?.filePath ?? "").includes("/.skill-router-requests/"));
  assert.ok(v2Write, "v2 write fixture present with nested state");
  v2Write.part.state.input.filePath = "/workspace/project/.skill-router-requests/00000000000000000000000000000000.txt";
  expectCaseFailure(
    () => inspectOpenCodeRun(toStdout(wrongToken), { scenario: "select", request: SELECT_REQUEST }),
    /written request token did not match the route command token/,
  );

  // out-of-order write (after the route invocation)
  const outOfOrder = clone(fixture(FILES.v1Select));
  const writeEvent = writeOf(outOfOrder);
  outOfOrder.splice(outOfOrder.indexOf(writeEvent), 1);
  const routeIndex = outOfOrder.findIndex((event) => String(event.part?.state?.input?.command ?? "").includes("skill-router route"));
  outOfOrder.splice(routeIndex + 1, 0, writeEvent);
  expectCaseFailure(
    () => inspectOpenCodeRun(toStdout(outOfOrder), { scenario: "select", request: SELECT_REQUEST }),
    /request file write occurred after the route invocation/,
  );

  // shell command writing the request file is always rejected
  const shellWrite = clone(fixture(FILES.v1Select));
  shellWrite.splice(2, 0, {
    type: "tool_use",
    sessionID: shellWrite[0].sessionID,
    part: {
      type: "tool",
      tool: "bash",
      state: {
        status: "completed",
        input: { command: "echo payload > /workspace/project/.skill-router-requests/aabbccddeeff00112233445566778899.txt" },
        output: "ok",
      },
    },
  });
  expectCaseFailure(
    () => inspectOpenCodeRun(toStdout(shellWrite), { scenario: "select", request: SELECT_REQUEST }),
    /shell command attempted to write the request file/,
  );

  // v1 none also requires the write (positive control already covered above)
  const noneMissing = clone(fixture(FILES.v1None)).filter((event) => !String(event.part?.state?.input?.path ?? "").includes("/.skill-router-requests/"));
  expectCaseFailure(() => inspectOpenCodeRun(toStdout(noneMissing), { scenario: "none", request: NONE_REQUEST }), /request file was never written/);
});

test("v2 fixtures use the nested part.state shape and normalization reads it", () => {
  const raw = fixture(FILES.v2Select);
  assert.ok(
    raw.filter((event) => event.part?.tool).every((event) => event.part.state && typeof event.part.state === "object"),
    "every v2 tool fixture record uses nested part.state.{status,input,output}",
  );
  const normalized = raw.map(normalizeOpenCodeEvent).filter(Boolean);
  const write = normalized.find((event) => event.tool === REQUEST_WRITE_TOOL);
  assert.ok(write, "v2 write tool normalized");
  assert.equal(write.status, "completed", "status read from part.state.status");
  assert.equal(write.input.filePath.includes("/.skill-router-requests/"), true, "input read from part.state.input");
  assert.equal(write.output, "request written", "output read from part.state.output");

  // Flattened compatibility remains, but nested is the exercised path.
  const flattened = normalizeOpenCodeEvent({
    type: "tool_use",
    sessionID: "ses_flat",
    part: { type: "tool", tool: "skill", status: "completed", input: { name: "release" } },
  });
  assert.equal(flattened.status, "completed");
  assert.equal(flattened.input.name, "release");
});

test("hostile event strings never cross the compact report boundary", () => {
  const hostileTool = "sk-ant-evil-0123456789";
  const hostileKind = "/workspace/project/evil-kind";
  const hostileName = "aabbccddeeff00112233445566778899";
  const hostileStatus = 'completed"; DROP TABLE skills--';
  const forbidden = [hostileTool.slice(0, 8), "/workspace", "sk-ant-", "0123456789", "DROP TABLE"];

  const openCodeSummary = summarizeOpenCodeEvents([
    {
      type: hostileKind,
      sessionID: "ses_hostile",
      part: { type: "tool", tool: hostileTool, state: { status: hostileStatus, input: { name: hostileName }, output: "x" } },
    },
    { type: "text", sessionID: "ses_hostile", part: { type: "text", text: `marker ${RELEASE_MARKER}` } },
  ]);
  const summaryJson = JSON.stringify(openCodeSummary);
  for (const needle of forbidden) assert.ok(!summaryJson.includes(needle), `OpenCode summary leaked: ${needle}`);
  assert.equal(openCodeSummary[0].kind, "event", "path-shaped kind collapsed to the bounded fallback");
  assert.equal(openCodeSummary[0].tool, undefined, "credential-shaped tool dropped");
  assert.equal(openCodeSummary[0].status, undefined, "hostile status dropped");
  assert.equal(openCodeSummary[0].name, undefined, "token-shaped skill name dropped");
  assert.equal(openCodeSummary[1].kind, "text");
  for (const entry of openCodeSummary) {
    for (const [key, value] of Object.entries(entry)) assert.ok(String(value).length <= 64, `bounded ${key}`);
  }

  const claudeSummary = summarizeClaudeEvents([
    {
      type: "assistant",
      session_id: "11111111-2222-3333-4444-555555555555",
      message: {
        content: [
          { type: "tool_use", id: "t1", name: hostileTool, input: { skill: hostileName } },
          { type: "tool_use", id: "t2", name: "Skill", input: { skill: hostileName } },
          { type: "text", text: "hello" },
        ],
      },
    },
  ]);
  const claudeJson = JSON.stringify(claudeSummary);
  for (const needle of forbidden) assert.ok(!claudeJson.includes(needle), `Claude summary leaked: ${needle}`);
  assert.equal(claudeSummary[0].tool, undefined, "credential-shaped block name dropped");
  assert.equal(claudeSummary[1].tool, "Skill");
  assert.equal(claudeSummary[1].name, undefined, "token-shaped skill name dropped");

  // Even a hostile failure-report payload is re-sanitized before emission.
  const report = buildFailureReport(
    { case: "opencode-v1-select", harness: "opencode-v1", scenario: "select" },
    new CaseAssertionError("inspect", `boom ${hostileTool}`, [...openCodeSummary, { kind: hostileKind, tool: hostileTool, status: hostileStatus, name: hostileName }], 1),
  );
  const reportJson = JSON.stringify(report);
  for (const needle of forbidden) assert.ok(!reportJson.includes(needle), `failure report leaked: ${needle}`);
  assert.ok(reportJson.length < 2000, "failure report stays compact");
  assert.equal(report.stage, "inspect");
  for (const entry of report.events) {
    assert.deepEqual(Object.keys(entry).filter((key) => !["kind", "tool", "status", "name"].includes(key)), []);
    for (const value of Object.values(entry)) assert.ok(String(value).length <= 64);
  }
});

function recordingRunner(env, extra = {}) {
  const calls = [];
  const runner = createRunner({
    executor: (argv) => {
      calls.push(argv);
      return { status: 0, stdout: "", stderr: "", signal: null, error: null };
    },
    cwd: repoRoot,
    env,
    stdout: () => {},
    stderr: () => {},
    ...extra,
  });
  return { runner, calls };
}

test("provider binding, unknown providers, and harness filters fail with zero subprocesses", () => {
  const openCodeBase = { PATH: process.env.PATH ?? "", SKILL_ROUTER_OPENCODE_MODEL: "openai/gpt-test-model", OPENAI_API_KEY: "sk-openai-live-0123456789" };

  // Wrong (unrelated) selected key for the model's provider.
  {
    const { runner, calls } = recordingRunner({ ...openCodeBase, ANTHROPIC_API_KEY: "sk-ant-live-0123456789abcdef" });
    assert.throws(
      () => runner.run({ harnessIds: ["opencode-v1"], secretEnv: ["ANTHROPIC_API_KEY"] }),
      (error) => error instanceof PlanError && error.message.includes('provider "openai" requires --secret-env OPENAI_API_KEY'),
    );
    assert.equal(calls.length, 0, "wrong-key rejection happens before any subprocess");
  }

  // Known-but-unmapped provider ids (google/gemini) and unknown providers.
  for (const provider of ["google", "gemini", "acme", "bedrock"]) {
    const { runner, calls } = recordingRunner({ PATH: process.env.PATH ?? "", SKILL_ROUTER_OPENCODE_MODEL: `${provider}/some-model` });
    assert.throws(
      () => runner.run({ harnessIds: ["opencode-v1"], secretEnv: [] }),
      (error) =>
        error instanceof PlanError &&
        error.message.includes(`unsupported OpenCode provider "${provider}"`) &&
        /supported providers are: anthropic, deepseek, groq, mistral, openai, openrouter, together, xai/.test(error.message) &&
        /google\/gemini are not mapped/.test(error.message),
      `provider rejected: ${provider}`,
    );
    assert.equal(calls.length, 0, `zero subprocesses for provider ${provider}`);
  }

  // --harness scoping: a Claude-only selection never demands OpenCode inputs.
  {
    const { runner, calls } = recordingRunner({ PATH: process.env.PATH ?? "" });
    assert.throws(
      () => runner.run({ harnessIds: ["claude"], secretEnv: [] }),
      (error) => {
        assert.ok(error instanceof PlanError);
        assert.ok(error.message.includes("SKILL_ROUTER_CLAUDE_MODEL"));
        assert.ok(error.message.includes("CLAUDE_CODE_OAUTH_TOKEN"), "the setup token is the required Claude credential");
        assert.ok(!error.message.includes("ANTHROPIC_API_KEY"), "an API key is never demanded for Claude cases");
        assert.ok(!error.message.includes("SKILL_ROUTER_OPENCODE_MODEL"), "OpenCode model not required for a Claude-only run");
        assert.ok(!error.message.includes("OpenCode provider"), "provider mapping not required for a Claude-only run");
        return true;
      },
    );
    assert.equal(calls.length, 0, "harness-filtered preflight runs before any subprocess");
  }

  // --harness scoping: an OpenCode-only selection never demands Claude inputs.
  {
    const { runner, calls } = recordingRunner({ PATH: process.env.PATH ?? "", SKILL_ROUTER_OPENCODE_MODEL: "openai/gpt-test-model" });
    assert.throws(
      () => runner.run({ harnessIds: ["opencode-v2"], secretEnv: [] }),
      (error) => {
        assert.ok(error instanceof PlanError);
        assert.ok(error.message.includes('provider "openai" requires --secret-env OPENAI_API_KEY'));
        assert.ok(!error.message.includes("ANTHROPIC_API_KEY"), "Claude key not required for an OpenCode-only run");
        assert.ok(!error.message.includes("CLAUDE_CODE_OAUTH_TOKEN"), "the Claude setup token is not required for an OpenCode-only run");
        assert.ok(!error.message.includes("SKILL_ROUTER_CLAUDE_MODEL"), "Claude model not required for an OpenCode-only run");
        return true;
      },
    );
    assert.equal(calls.length, 0, "harness-filtered preflight runs before any subprocess");
  }
});

/* ------------------ Gate 2 final remediation coverage ----------------------- */

const CLAUDE_MODEL_ACCEPTED = ["sonnet", "opus", "haiku", "claude-sonnet-4-5", "claude-3-5-haiku-20241022", "claude-opus-4-1-20250805"];
const CLAUDE_MODEL_REJECTED = ["anthropic/claude-sonnet-4-5", "openai/gpt-5", "Sonnet", "claude", "provider/model", "", undefined];
const OPENCODE_MODEL_ACCEPTED = ["openai/gpt-5", "anthropic/claude-sonnet-4-5", "openrouter/org/model", "provider/model"];
const OPENCODE_MODEL_REJECTED = ["sonnet", "claude-sonnet-4-5", "openai", "", undefined];

function containerClaudeAccepts(value) {
  try {
    const resolved = requireClaudeModel({ SKILL_ROUTER_CLAUDE_MODEL: value });
    return resolved === value ? true : resolved;
  } catch (error) {
    assert.ok(error instanceof CaseAssertionError, `claude resolver must throw CaseAssertionError, got ${error?.name}`);
    return false;
  }
}

function containerOpenCodeAccepts(value) {
  try {
    const resolved = requireOpenCodeModel({ SKILL_ROUTER_OPENCODE_MODEL: value });
    return resolved === value ? true : resolved;
  } catch (error) {
    assert.ok(error instanceof CaseAssertionError, `opencode resolver must throw CaseAssertionError, got ${error?.name}`);
    return false;
  }
}

function hostClaudeAccepts(value) {
  try {
    preflightLiveCases({
      manifest,
      env: { SKILL_ROUTER_CLAUDE_MODEL: value, CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-live-0123456789abcdef" },
      caseIds: ["claude-control"],
      selectedSecretNames: ["CLAUDE_CODE_OAUTH_TOKEN"],
    });
    return true;
  } catch (error) {
    assert.ok(error instanceof PlanError, `host preflight must throw PlanError, got ${error?.name}`);
    return false;
  }
}

test("host and in-container model validators are the same tables with no runtime coupling", () => {
  // Identical explicit constants (the staged runner never imports host files).
  assert.equal(CONTAINER_OPENCODE_MODEL_RE.source, HOST_OPENCODE_MODEL_RE.source);
  assert.equal(CONTAINER_OPENCODE_MODEL_RE.flags, HOST_OPENCODE_MODEL_RE.flags);
  assert.equal(CLAUDE_MODEL_FORMAT_RE.source, HOST_CLAUDE_MODEL_RE.source);
  assert.equal(CLAUDE_MODEL_FORMAT_RE.flags, HOST_CLAUDE_MODEL_RE.flags);
  assert.deepEqual([...CLAUDE_MODEL_ALIASES], ["sonnet", "opus", "haiku"]);

  // Container resolvers: the exact functions runOpenCode/runClaude call.
  for (const value of CLAUDE_MODEL_ACCEPTED) {
    assert.equal(containerClaudeAccepts(value), true, `claude resolver accepts ${value}`);
    assert.equal(requireClaudeModel({ SKILL_ROUTER_CLAUDE_MODEL: value }), value, "value returned unchanged for claude --model");
  }
  for (const value of CLAUDE_MODEL_REJECTED) {
    assert.equal(containerClaudeAccepts(value), false, `claude resolver rejects ${JSON.stringify(value)}`);
  }
  for (const value of OPENCODE_MODEL_ACCEPTED) {
    assert.equal(containerOpenCodeAccepts(value), true, `opencode resolver accepts ${value}`);
    assert.equal(requireOpenCodeModel({ SKILL_ROUTER_OPENCODE_MODEL: value }), value, "value returned unchanged");
  }
  for (const value of OPENCODE_MODEL_REJECTED) {
    assert.equal(containerOpenCodeAccepts(value), false, `opencode resolver rejects ${JSON.stringify(value)}`);
  }

  // Host/container acceptance tables agree.
  for (const value of [...new Set([...CLAUDE_MODEL_ACCEPTED, ...CLAUDE_MODEL_REJECTED])]) {
    assert.equal(hostClaudeAccepts(value), containerClaudeAccepts(value), `claude table disagreement for ${JSON.stringify(value)}`);
  }
  for (const value of [...new Set([...OPENCODE_MODEL_ACCEPTED, ...OPENCODE_MODEL_REJECTED])]) {
    assert.equal(HOST_OPENCODE_MODEL_RE.test(String(value ?? "")), containerOpenCodeAccepts(value), `opencode format table disagreement for ${JSON.stringify(value)}`);
  }

  // Cross-property: each side rejects everything the other accepts.
  for (const value of OPENCODE_MODEL_ACCEPTED) assert.equal(containerClaudeAccepts(value), false, `claude rejects OpenCode form ${value}`);
  for (const value of CLAUDE_MODEL_ACCEPTED) assert.equal(containerOpenCodeAccepts(value), false, `opencode rejects claude alias ${value}`);

  // Missing env never yields a default.
  assert.throws(() => requireClaudeModel({}), (error) => error instanceof CaseAssertionError && /no default billable model/.test(error.message));
  assert.throws(() => requireOpenCodeModel({}), (error) => error instanceof CaseAssertionError && /no default billable model/.test(error.message));
});

test("overlong event-derived names are replaced by a neutral bounded value", () => {
  const overlong = "a".repeat(128);
  const atLimit = "b".repeat(64);
  const justOver = "c".repeat(65);

  const skillEvent = (input) => [{ type: "tool_use", sessionID: "ses_hostile", part: { type: "tool", tool: "skill", state: { status: "completed", input, output: "loaded" } } }];

  const openCodeName = summarizeOpenCodeEvents(skillEvent({ name: overlong }));
  assert.equal(openCodeName[0].name, OVERLONG_NAME_PLACEHOLDER, "overlong OpenCode skill name neutralized");
  const openCodeId = summarizeOpenCodeEvents(skillEvent({ id: overlong }));
  assert.equal(openCodeId[0].name, OVERLONG_NAME_PLACEHOLDER, "overlong OpenCode skill id neutralized");
  assert.equal(summarizeOpenCodeEvents(skillEvent({ name: atLimit }))[0].name, atLimit, "64-char name passes");
  assert.equal(summarizeOpenCodeEvents(skillEvent({ name: justOver }))[0].name, OVERLONG_NAME_PLACEHOLDER, "65-char name rejected");
  for (const summary of [openCodeName, openCodeId]) {
    const json = JSON.stringify(summary);
    assert.ok(!json.includes(overlong), "raw overlong name never reaches the summary");
    assert.ok(json.length < 200, "summary stays compact");
  }

  const claudeSummary = summarizeClaudeEvents([
    { type: "assistant", session_id: "11111111-2222-3333-4444-555555555555", message: { content: [{ type: "tool_use", id: "t1", name: "Skill", input: { skill: overlong } }] } },
  ]);
  assert.equal(claudeSummary[0].name, OVERLONG_NAME_PLACEHOLDER, "overlong Claude skill name neutralized");
  assert.ok(!JSON.stringify(claudeSummary).includes(overlong), "raw overlong name never reaches the Claude summary");

  // The failure-report boundary re-applies the same bounds.
  const report = buildFailureReport(
    { case: "claude-select", harness: "claude", scenario: "select" },
    new CaseAssertionError("inspect", "boom", [...openCodeName, ...claudeSummary, { kind: "tool_use", tool: "Skill", status: "completed", name: overlong }], 1),
  );
  const reportJson = JSON.stringify(report);
  assert.ok(!reportJson.includes(overlong), "raw overlong name never reaches the report");
  const names = report.events.map((entry) => entry.name).filter((value) => value !== undefined);
  assert.ok(names.length >= 1);
  for (const name of names) {
    assert.ok(name.length <= 64, "report name values are bounded");
    assert.equal(name, OVERLONG_NAME_PLACEHOLDER);
  }
});

test("any shell command referencing the request directory is rejected in every form", () => {
  const token = "aabbccddeeff00112233445566778899";
  const forms = [
    // Stable project spool (`.skill-router-requests`): every transport form.
    ["relative", `echo payload > .skill-router-requests/${token}.txt`],
    ["leading ./", `echo payload > ./.skill-router-requests/${token}.txt`],
    ["absolute", `echo payload > /workspace/project/.skill-router-requests/${token}.txt`],
    ["double-quoted relative", `echo payload > ".skill-router-requests/${token}.txt"`],
    ["single-quoted absolute", `echo payload > '/workspace/project/.skill-router-requests/${token}.txt'`],
    ["backslash relative", `echo payload > .skill-router-requests\\${token}.txt`],
    ["mkdir + write", `mkdir -p .skill-router-requests && printf x > .skill-router-requests/${token}.txt`],
    // Retired legacy spool (`.skill-router/requests`): equally suspicious and
    // never accepted as a valid proof target.
    ["legacy relative", `echo payload > .skill-router/requests/${token}.txt`],
    ["legacy leading ./", `echo payload > ./.skill-router/requests/${token}.txt`],
    ["legacy absolute", `echo payload > /workspace/project/.skill-router/requests/${token}.txt`],
    ["legacy double-quoted relative", `echo payload > ".skill-router/requests/${token}.txt"`],
    ["legacy single-quoted absolute", `echo payload > '/workspace/project/.skill-router/requests/${token}.txt'`],
    ["legacy backslash relative", `echo payload > .skill-router\\requests\\${token}.txt`],
    ["legacy mkdir + write", `mkdir -p .skill-router/requests && printf x > .skill-router/requests/${token}.txt`],
  ];
  for (const [label, command] of forms) {
    const events = clone(fixture(FILES.v1Select));
    events.splice(2, 0, {
      type: "tool_use",
      sessionID: events[0].sessionID,
      part: { type: "tool", tool: "bash", state: { status: "completed", input: { command }, output: "ok" } },
    });
    expectCaseFailure(
      () => inspectOpenCodeRun(toStdout(events), { scenario: "select", request: SELECT_REQUEST }),
      /shell command attempted to write the request file/,
      `form: ${label}`,
    );
  }

  // The mandatory completed Write proof still holds on the untouched fixture.
  const positive = inspectOpenCodeRun(toStdout(fixture(FILES.v1Select)), { scenario: "select", request: SELECT_REQUEST });
  assert.deepEqual(positive.chain, expectedCaseChain("opencode-v1", "select"));
});

/* ------------- Claude setup-token auth (Milestone A, non-bare) ---------------- */

test("Claude live cases require the setup token before any subprocess, never an API key", () => {
  const claudeBase = { PATH: process.env.PATH ?? "", SKILL_ROUTER_CLAUDE_MODEL: "sonnet" };
  const tokenValue = "sk-ant-oat01-live-0123456789abcdef";

  // 1. API key alone: rejected, the message asks for the token instead, and
  //    not a single subprocess (pack/build/probe/container) has started.
  {
    const { runner, calls } = recordingRunner({ ...claudeBase, ANTHROPIC_API_KEY: "sk-ant-live-0123456789abcdef" });
    assert.throws(
      () => runner.run({ harnessIds: ["claude"], secretEnv: ["ANTHROPIC_API_KEY"] }),
      (error) => {
        assert.ok(error instanceof PlanError);
        assert.ok(/refusing to start live case containers/.test(error.message));
        assert.ok(error.message.includes("CLAUDE_CODE_OAUTH_TOKEN"), "the setup token is the required credential");
        assert.ok(!error.message.includes("ANTHROPIC_API_KEY"), "no API-key fallback: a key is never requested");
        return true;
      },
    );
    assert.equal(calls.length, 0, "no API-key selection starts zero subprocesses");
  }

  // 2. Token name selected but no host value: still zero subprocesses.
  {
    const { runner, calls } = recordingRunner(claudeBase);
    assert.throws(
      () => runner.run({ harnessIds: ["claude"], secretEnv: ["CLAUDE_CODE_OAUTH_TOKEN"] }),
      (error) =>
        error instanceof PlanError &&
        /CLAUDE_CODE_OAUTH_TOKEN must be set in the host environment with at least 8 characters/.test(error.message),
    );
    assert.equal(calls.length, 0, "missing token fails before any subprocess");
  }

  // 3. Present but implausible token: zero subprocesses, value never echoed.
  {
    const { runner, calls } = recordingRunner({ ...claudeBase, CLAUDE_CODE_OAUTH_TOKEN: "short" });
    assert.throws(
      () => runner.run({ harnessIds: ["claude"], secretEnv: ["CLAUDE_CODE_OAUTH_TOKEN"] }),
      (error) =>
        error instanceof PlanError &&
        /at least 8 characters/.test(error.message) &&
        !error.message.includes("short"),
    );
    assert.equal(calls.length, 0, "short token fails before any subprocess");
  }

  // 4. Positive control: with the token present, preflight passes and the
  //    lifecycle reaches Docker (the next gate, not the credential gate).
  {
    const { runner, calls } = recordingRunner({ ...claudeBase, CLAUDE_CODE_OAUTH_TOKEN: tokenValue });
    assert.throws(
      () => runner.run({ harnessIds: ["claude"], secretEnv: ["CLAUDE_CODE_OAUTH_TOKEN"] }),
      (error) => error instanceof PlanError && /Docker is configured for|daemon is not reachable/.test(error.message),
      "credential preflight passed; the run stops at the Docker probe instead",
    );
    assert.ok(calls.length > 0, "only Docker probes run after a satisfied credential gate");
    assert.ok(
      calls.every((argv) => !argv.join(" ").includes(tokenValue)),
      "the token value never appears in any executed command",
    );
    assert.ok(
      calls.every((argv) => argv[0] !== "docker" || argv[1] !== "build" || !argv.join(" ").includes(tokenValue)),
      "build argv never carries the token",
    );
  }

  // 5. Transport note (value-free) is reported when the token is selected.
  const preflight = preflightLiveCases({
    manifest,
    env: { ...claudeBase, CLAUDE_CODE_OAUTH_TOKEN: tokenValue },
    caseIds: ["claude-select"],
    selectedSecretNames: ["CLAUDE_CODE_OAUTH_TOKEN"],
  });
  assert.ok(preflight.notes.some((note) => note.includes("CLAUDE_CODE_OAUTH_TOKEN")), "transport is documented in notes");
  assert.ok(!preflight.notes.some((note) => note.includes(tokenValue)), "notes never carry the value");
  assert.ok(!JSON.stringify(preflight).includes(tokenValue), "the whole preflight payload is value-free");
});

test("the Claude child environment is setup-token only with a fresh container-local config root", () => {
  assert.equal(CONTAINER_MIN_SECRET_LENGTH, HOST_MIN_SECRET_LENGTH, "host and container agree on the minimum token length");

  const environment = claudeRunEnv({
    HOME: "/home/node",
    PATH: "/usr/local/bin",
    ANTHROPIC_API_KEY: "sk-ant-live-0123456789abcdef",
    CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-live-0123456789abcdef",
    CLAUDE_CONFIG_DIR: "/Users/ci-host/.claude",
  });
  assert.equal(environment.CLAUDE_CODE_OAUTH_TOKEN, "sk-ant-oat01-live-0123456789abcdef", "the setup token is inherited");
  assert.ok(!("ANTHROPIC_API_KEY" in environment), "the Claude child can never fall back to API-key auth");
  assert.equal(environment.CLAUDE_CONFIG_DIR, "/home/node/.claude", "config root is the fresh tmpfs HOME one");
  assert.equal(environment.PWD, "/workspace/project");
  assert.equal(environment.SKILL_ROUTER_HOME, "/home/node");
  assert.equal(environment.CLAUDE_CODE_DISABLE_SKILLS_SYNC, "1", "no remote skill sync in a hermetic case");
  assert.equal(
    environment.PATH,
    ROUTER_WRAPPER_DIR,
    "wrapper dir is the single deterministic PATH entry (never doubled)",
  );
  assert.ok(!environment.PATH.includes("node_modules/.bin"), "the non-executable package bin is never exposed");

  const defaults = claudeRunEnv({ PATH: "/usr/bin" });
  assert.equal(defaults.CLAUDE_CONFIG_DIR, "/home/node/.claude", "HOME-less env still resolves the container HOME");
  assert.equal(defaults.PATH, `${ROUTER_WRAPPER_DIR}:/usr/bin`, "the incoming PATH survives after the wrapper dir");
});

/** Inert plugin manifest fixture for launch-surface tests: production keys,
 * production namespace, no execution surface of any kind. */
function inertPluginManifestText(version = "0.1.0") {
  return `${JSON.stringify(
    {
      name: PLUGIN_NAME,
      version,
      description: "inert test manifest",
      author: { name: "skill-router" },
    },
    null,
    2,
  )}\n`;
}

test("non-bare Claude launch surfaces must be clean before any subprocess starts", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "skill-router-claude-surfaces-"));
  try {
    const projectDir = path.join(root, "project");
    const homeDir = path.join(root, "home");
    // Production-relative layout: <claude state>/plugins/<plugin>.
    const pluginDir = path.join(root, "claude", "plugins", PLUGIN_NAME);
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });

    // Clean control: fresh HOME, empty/absent config root, no plugin, and no
    // router-owned Claude state at all (control never initializes).
    assert.deepEqual(
      assertClaudeLaunchSurfaces({ scenario: "control", projectDir, homeDir, pluginDir }),
      { scenario: "control", configFresh: true, plugin: false },
    );

    // Every project config/skill/MCP surface is rejected.
    for (const entry of FORBIDDEN_PROJECT_CLAUDE_ENTRIES) {
      const target = path.join(projectDir, entry);
      if (entry === ".claude") mkdirSync(path.join(target, "skills"), { recursive: true });
      else writeFileSync(target, "{}\n");
      expectCaseFailure(
        () => assertClaudeLaunchSurfaces({ scenario: "control", projectDir, homeDir, pluginDir }),
        /project \.claude|project \.claude\.json|project \.mcp\.json/,
      );
      rmSync(target, { recursive: true, force: true });
    }

    // The wrapper ships in the immutable image layer: neither a project-local
    // `bin/` nor a runtime-created workspace `bin/` sibling may exist, and
    // there is no tolerance exception for a wrapper on a tmpfs anymore.
    mkdirSync(path.join(projectDir, "bin"), { recursive: true });
    writeFileSync(path.join(projectDir, "bin", "skill-router"), "#!/usr/local/bin/node\n");
    expectCaseFailure(
      () => assertClaudeLaunchSurfaces({ scenario: "control", projectDir, homeDir, pluginDir }),
      /project bin directory/,
    );
    rmSync(path.join(projectDir, "bin"), { recursive: true, force: true });

    const workspaceBin = path.join(path.dirname(projectDir), "bin");
    mkdirSync(workspaceBin, { recursive: true });
    writeFileSync(path.join(workspaceBin, "skill-router"), "#!/usr/local/bin/node\n");
    expectCaseFailure(
      () => assertClaudeLaunchSurfaces({ scenario: "control", projectDir, homeDir, pluginDir }),
      /workspace bin directory/,
      "a runtime-created workspace wrapper directory is never tolerated",
    );
    rmSync(workspaceBin, { recursive: true, force: true });
    assert.deepEqual(
      assertClaudeLaunchSurfaces({ scenario: "control", projectDir, homeDir, pluginDir }),
      { scenario: "control", configFresh: true, plugin: false },
      "surfaces are clean again once the stray directory is gone",
    );

    // HOME-side MCP/global-config surfaces are rejected too.
    for (const entry of FORBIDDEN_HOME_CLAUDE_ENTRIES) {
      writeFileSync(path.join(homeDir, entry), "{}\n");
      expectCaseFailure(
        () => assertClaudeLaunchSurfaces({ scenario: "control", projectDir, homeDir, pluginDir }),
        new RegExp(`home ${entry.replace(/\./g, "\\.")}`),
      );
      rmSync(path.join(homeDir, entry), { force: true });
    }

    // A non-empty CLAUDE_CONFIG_DIR is not fresh: settings/hooks/commands/
    // agents/plugins/MCP must not pre-exist for a non-bare run.
    for (const entry of ["settings.json", "hooks", "commands", "agents", "plugins", "mcp.json", "skills"]) {
      mkdirSync(path.join(homeDir, ".claude"), { recursive: true });
      const target = path.join(homeDir, ".claude", entry);
      if (entry === "settings.json" || entry === "mcp.json") writeFileSync(target, "{}\n");
      else mkdirSync(target, { recursive: true });
      expectCaseFailure(
        () => assertClaudeLaunchSurfaces({ scenario: "select", projectDir, homeDir, pluginDir }),
        /config root not fresh/,
      );
      rmSync(path.join(homeDir, ".claude"), { recursive: true, force: true });
    }

    // An empty config directory (or none at all) is accepted.
    mkdirSync(path.join(homeDir, ".claude"), { recursive: true });
    assert.deepEqual(
      assertClaudeLaunchSurfaces({ scenario: "control", projectDir, homeDir, pluginDir }),
      { scenario: "control", configFresh: true, plugin: false },
      "an empty config root with no plugin is a clean control surface",
    );
    expectCaseFailure(
      () => assertClaudeLaunchSurfaces({ scenario: "none", projectDir, homeDir, pluginDir }),
      /plugin root must contain exactly/,
      "a routed case still requires the generated plugin",
    );
    rmSync(path.join(homeDir, ".claude"), { recursive: true, force: true });

    // Control must never expose the plugin directory...
    mkdirSync(path.join(pluginDir, "skills"), { recursive: true });
    expectCaseFailure(
      () => assertClaudeLaunchSurfaces({ scenario: "control", projectDir, homeDir, pluginDir }),
      /control must not expose the plugin directory/,
    );

    // ...nor router-owned Claude state at all: even a marketplace-only state
    // directory proves the case initialized something.
    rmSync(pluginDir, { recursive: true, force: true });
    mkdirSync(path.join(root, "claude", ".claude-plugin"), { recursive: true });
    expectCaseFailure(
      () => assertClaudeLaunchSurfaces({ scenario: "control", projectDir, homeDir, pluginDir }),
      /control must not expose router-owned Claude state/,
    );

    // A routed case accepts exactly `.claude-plugin/plugin.json` + `skills/`.
    rmSync(path.join(root, "claude"), { recursive: true, force: true });
    const skillDir = path.join(pluginDir, "skills", "skill-router");
    mkdirSync(path.join(pluginDir, ".claude-plugin"), { recursive: true });
    writeFileSync(path.join(pluginDir, ".claude-plugin", "plugin.json"), inertPluginManifestText());
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: skill-router\n---\n");
    assert.deepEqual(
      assertClaudeLaunchSurfaces({ scenario: "select", projectDir, homeDir, pluginDir }),
      { scenario: "select", configFresh: true, plugin: true },
    );

    // Anything beyond the inert manifest in `.claude-plugin/` is rejected.
    writeFileSync(path.join(pluginDir, ".claude-plugin", "settings.json"), "{}\n");
    expectCaseFailure(
      () => assertClaudeLaunchSurfaces({ scenario: "select", projectDir, homeDir, pluginDir }),
      /plugin \.claude-plugin must contain exactly/,
    );
    rmSync(path.join(pluginDir, ".claude-plugin", "settings.json"), { force: true });

    // MCP or config surfaces at the plugin root are rejected.
    writeFileSync(path.join(pluginDir, ".mcp.json"), "{}\n");
    expectCaseFailure(
      () => assertClaudeLaunchSurfaces({ scenario: "select", projectDir, homeDir, pluginDir }),
      /plugin root must contain exactly/,
    );
    rmSync(path.join(pluginDir, ".mcp.json"), { force: true });

    // The retired `.claude/skills` layout is rejected as an extra root entry.
    mkdirSync(path.join(pluginDir, ".claude", "skills"), { recursive: true });
    expectCaseFailure(
      () => assertClaudeLaunchSurfaces({ scenario: "select", projectDir, homeDir, pluginDir }),
      /plugin root must contain exactly/,
    );
    rmSync(path.join(pluginDir, ".claude"), { recursive: true, force: true });

    // The manifest must be inert metadata: any extra field or any other name
    // fails closed.
    writeFileSync(
      path.join(pluginDir, ".claude-plugin", "plugin.json"),
      `${JSON.stringify({ name: PLUGIN_NAME, version: "0.1.0", description: "x", author: { name: "skill-router" }, paths: ["skills"] }, null, 2)}\n`,
    );
    expectCaseFailure(
      () => assertClaudeLaunchSurfaces({ scenario: "select", projectDir, homeDir, pluginDir }),
      /plugin manifest must carry inert metadata only/,
      "path/dependency-style manifest fields are never accepted",
    );
    writeFileSync(
      path.join(pluginDir, ".claude-plugin", "plugin.json"),
      `${JSON.stringify({ name: "skill-router", version: "0.1.0", description: "x", author: { name: "skill-router" } }, null, 2)}\n`,
    );
    expectCaseFailure(
      () => assertClaudeLaunchSurfaces({ scenario: "select", projectDir, homeDir, pluginDir }),
      /plugin manifest carries the wrong namespace/,
    );

    // With installation metadata in play, the manifest version must match it.
    writeFileSync(path.join(pluginDir, ".claude-plugin", "plugin.json"), inertPluginManifestText());
    assert.doesNotThrow(() =>
      assertClaudeLaunchSurfaces({
        scenario: "select",
        projectDir,
        homeDir,
        pluginDir,
        installation: { version: "0.1.0" },
      }),
    );
    expectCaseFailure(
      () =>
        assertClaudeLaunchSurfaces({
          scenario: "select",
          projectDir,
          homeDir,
          pluginDir,
          installation: { version: "9.9.9" },
        }),
      /plugin manifest version does not match installation metadata/,
    );
    writeFileSync(path.join(pluginDir, ".claude-plugin", "plugin.json"), "{ not json");
    expectCaseFailure(
      () => assertClaudeLaunchSurfaces({ scenario: "select", projectDir, homeDir, pluginDir }),
      /plugin manifest is not valid JSON/,
    );
    rmSync(path.join(pluginDir, ".claude-plugin", "plugin.json"), { force: true });
    expectCaseFailure(
      () => assertClaudeLaunchSurfaces({ scenario: "select", projectDir, homeDir, pluginDir }),
      /plugin \.claude-plugin must contain exactly/,
      "an absent manifest is caught by the exact-entry check",
    );
    mkdirSync(path.join(pluginDir, ".claude-plugin", "plugin.json"), { recursive: true });
    expectCaseFailure(
      () => assertClaudeLaunchSurfaces({ scenario: "select", projectDir, homeDir, pluginDir }),
      /plugin manifest is missing/,
      "the manifest must be a regular file, never a directory",
    );
    rmSync(path.join(pluginDir, ".claude-plugin", "plugin.json"), { recursive: true, force: true });
    writeFileSync(path.join(pluginDir, ".claude-plugin", "plugin.json"), inertPluginManifestText());

    rmSync(path.join(skillDir, "SKILL.md"), { force: true });
    expectCaseFailure(
      () => assertClaudeLaunchSurfaces({ scenario: "none", projectDir, homeDir, pluginDir }),
      /generated plugin is missing the router skill/,
    );
    writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: skill-router\n---\n");

    // No symlink or special file may ever live inside the plugin tree.
    symlinkSync(path.join(skillDir, "SKILL.md"), path.join(skillDir, "alias.md"));
    expectCaseFailure(
      () => assertClaudeLaunchSurfaces({ scenario: "select", projectDir, homeDir, pluginDir }),
      /generated plugin tree contains a symlink/,
    );
    rmSync(path.join(skillDir, "alias.md"), { force: true });
    assert.deepEqual(
      assertClaudeLaunchSurfaces({ scenario: "select", projectDir, homeDir, pluginDir }),
      { scenario: "select", configFresh: true, plugin: true },
      "the exact plugin layout is clean again",
    );

    // The project-owned registration surface: exactly `settings.local.json`
    // for routed cases, never for control, never in any other shape.
    mkdirSync(path.join(projectDir, ".claude"), { recursive: true });
    writeFileSync(
      path.join(projectDir, ".claude", "settings.local.json"),
      JSON.stringify({ extraKnownMarketplaces: { "skill-router-abc": { source: { source: "directory", path: "/x" } } } }),
    );
    assert.deepEqual(
      assertClaudeLaunchSurfaces({ scenario: "none", projectDir, homeDir, pluginDir }),
      { scenario: "none", configFresh: true, plugin: true },
      "the exact local registration is a clean routed surface",
    );
    expectCaseFailure(
      () => assertClaudeLaunchSurfaces({ scenario: "control", projectDir, homeDir, pluginDir }),
      /project \.claude/,
      "control must not expose any project Claude surface",
    );
    writeFileSync(path.join(projectDir, ".claude", "extra.json"), "{}\n");
    expectCaseFailure(
      () => assertClaudeLaunchSurfaces({ scenario: "none", projectDir, homeDir, pluginDir }),
      /project \.claude not exactly settings\.local\.json/,
    );
    rmSync(path.join(projectDir, ".claude"), { recursive: true, force: true });

    expectCaseFailure(
      () => assertClaudeLaunchSurfaces({ scenario: "sideways", projectDir, homeDir, pluginDir }),
      /claude scenarios are control\/select\/none/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


/* ----------- Claude plugin: production generation, layout, policy ---------- */

function sortedNames(target) {
  return readdirSync(target).sort();
}

/**
 * Generate the production Claude integration into a project-shaped temporary
 * root with the packaged production modules. The case runner never builds
 * this itself — it only consumes and verifies this output.
 */
async function generateProductionPlugin(root) {
  const projectDir = path.join(root, "project");
  const homeDir = path.join(root, "home");
  const state = path.join(projectDir, ".skill-router");
  const sources = path.join(projectDir, "sources", "release");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(path.join(sources, "references"), { recursive: true });
  writeFileSync(
    path.join(sources, "SKILL.md"),
    "---\nname: Release Display Name\ndescription: Prepare notes and publish releases\nlicense: MIT\n---\n\n# Release\n\nWhen loaded, return RELEASE_SKILL_LOADED.\n",
  );
  writeFileSync(path.join(sources, "references", "steps.md"), "# Publish steps\n");

  const registry = {
    schemaVersion: 1,
    fingerprint: "f".repeat(64),
    skills: [
      {
        id: "release",
        name: "release",
        description: "Prepare notes and publish releases",
        source: path.join(sources, "SKILL.md"),
        enabled: true,
      },
    ],
  };
  mkdirSync(state, { recursive: true });
  writeFileSync(path.join(state, ".skill-router-owned"), "skill-router-state-v1\n");
  const registryFile = path.join(state, "registry.json");
  writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);

  const identity = claudeIdentity({ global: false, stateDirectory: state });
  const plan = await planClaudePlugin({
    registry,
    identity,
    stateDirectory: state,
    // The generated router skill must point at the stable project spool
    // (Phase 7 ingress), never at the retired `<state>/requests` directory.
    requestDirectory: "/workspace/project/.skill-router-requests",
  });
  await stageClaudePlugin(plan, state);
  const installation = buildInstallation({
    global: false,
    stateDirectory: state,
    harnesses: ["claude"],
    claude: { fingerprint: plan.fingerprint, version: plan.version },
  });
  const installationFile = path.join(state, "installation.json");
  writeFileSync(installationFile, `${JSON.stringify(installation, null, 2)}\n`);

  return {
    projectDir,
    homeDir,
    state,
    identity,
    plan,
    installation,
    registryFile,
    installationFile,
    stateDir: path.join(state, "claude"),
    pluginDir: path.join(state, "claude", "plugins", PLUGIN_NAME),
  };
}

function installationCheck(fixture) {
  return assertClaudeInstallation({
    installationFile: fixture.installationFile,
    stateDir: fixture.stateDir,
    pluginDir: fixture.pluginDir,
    registryFile: fixture.registryFile,
  });
}

test("the case runner consumes the production plugin and carries no bridge builder", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "skill-router-plugin-production-"));
  try {
    const fixture = await generateProductionPlugin(root);

    // Production constants are the only source of truth for namespace/paths:
    // the container path is the project-scoped production layout, and the
    // marketplace name is the production hash of scope + state path.
    assert.equal(PLUGIN_NAME, CLAUDE_PLUGINS.project);
    assert.equal(PLUGIN_NAME, "openagency-skill-router");
    assert.equal(
      PLUGIN_DIR,
      path.join("/workspace/project", ".skill-router", "claude", "plugins", PLUGIN_NAME),
    );
    assert.equal(
      fixture.pluginDir,
      path.join(fixture.projectDir, ".skill-router", "claude", "plugins", PLUGIN_NAME),
    );
    assert.equal(
      productionClaudeMarketplaceName("project", fixture.state),
      fixture.installation.claude.marketplace,
    );
    assert.deepEqual(sortedNames(fixture.stateDir), [".claude-plugin", "plugins"]);
    assert.deepEqual(sortedNames(fixture.pluginDir), [".claude-plugin", "skills"]);
    assert.deepEqual(sortedNames(path.join(fixture.pluginDir, "skills")), ["release", "skill-router"]);
    assert.deepEqual(
      sortedNames(path.join(fixture.pluginDir, "skills", "release")),
      ["SKILL.md", "references"],
      "support files travel with the generated skill",
    );

    // Inert manifest only: production key set, production namespace, recorded
    // version — no paths, hooks, MCP servers, commands, agents, dependencies,
    // or executables.
    const manifest = JSON.parse(
      readFileSync(path.join(fixture.pluginDir, ".claude-plugin", "plugin.json"), "utf8"),
    );
    assert.deepEqual(Object.keys(manifest).sort(), [...PLUGIN_MANIFEST_KEYS].sort());
    assert.equal(manifest.name, PLUGIN_NAME);
    assert.equal(manifest.version, fixture.installation.claude.version);
    for (const forbidden of ["paths", "dependencies", "settings", "commands", "hooks", "agents", "mcpServers", "executable"]) {
      assert.ok(!(forbidden in manifest), `manifest never declares ${forbidden}`);
    }

    // Generated from the *source* document, never from the rewritten OpenCode
    // managed copy: canonical name override, preserved source fields, no
    // OpenCode autoinvoke marker, verbatim body.
    const pluginSkill = readFileSync(path.join(fixture.pluginDir, "skills", "release", "SKILL.md"), "utf8");
    assert.ok(pluginSkill.includes("name: release"), "canonical name override");
    assert.ok(pluginSkill.includes("license: MIT"), "source frontmatter fields preserved");
    assert.ok(!pluginSkill.includes("opencode/autoinvoke"), "never the rewritten OpenCode copy");
    assert.ok(pluginSkill.includes("RELEASE_SKILL_LOADED"), "body preserved");

    // Marketplace identity: recorded hash, one plugin entry, matching version.
    const marketplace = JSON.parse(
      readFileSync(path.join(fixture.stateDir, ".claude-plugin", "marketplace.json"), "utf8"),
    );
    assert.equal(marketplace.name, fixture.installation.claude.marketplace);
    assert.equal(marketplace.plugins.length, 1);
    assert.equal(marketplace.plugins[0].name, PLUGIN_NAME);
    assert.equal(marketplace.plugins[0].source, `./plugins/${PLUGIN_NAME}`);
    assert.equal(marketplace.plugins[0].version, fixture.installation.claude.version);

    // Full structural verification by the runner, then launch surfaces.
    const verified = installationCheck(fixture);
    assert.equal(verified.pluginDir, fixture.pluginDir);
    assert.equal(verified.marketplace, fixture.installation.claude.marketplace);
    assert.equal(verified.version, fixture.installation.claude.version);
    assert.equal(verified.fingerprint, fixture.installation.claude.fingerprint);
    assert.equal(verified.skillCount, 1);
    assert.deepEqual(
      assertClaudeLaunchSurfaces({
        scenario: "select",
        projectDir: fixture.projectDir,
        homeDir: fixture.homeDir,
        pluginDir: fixture.pluginDir,
        installation: fixture.installation,
      }),
      { scenario: "select", configFresh: true, plugin: true },
    );

    // Exact-layout failures all fail closed.
    rmSync(path.join(fixture.pluginDir, "skills", "release", "SKILL.md"), { force: true });
    expectCaseFailure(() => installationCheck(fixture), /generated plugin is missing skill release/);
    await stageClaudePlugin(fixture.plan, fixture.state);

    writeFileSync(
      path.join(fixture.pluginDir, ".claude-plugin", "plugin.json"),
      `${JSON.stringify({ name: "skill-router", version: "0.1.0", description: "x", author: { name: "skill-router" } }, null, 2)}\n`,
    );
    expectCaseFailure(() => installationCheck(fixture), /plugin manifest carries the wrong namespace/);
    writeFileSync(
      path.join(fixture.pluginDir, ".claude-plugin", "plugin.json"),
      `${JSON.stringify({ name: PLUGIN_NAME, version: "0.1.0", description: "x", author: { name: "skill-router" }, hooks: {} }, null, 2)}\n`,
    );
    expectCaseFailure(() => installationCheck(fixture), /plugin manifest must carry inert metadata only/);
    await stageClaudePlugin(fixture.plan, fixture.state);

    const marketplaceManifest = path.join(fixture.stateDir, ".claude-plugin", "marketplace.json");
    const originalMarketplace = readFileSync(marketplaceManifest, "utf8");
    writeFileSync(
      marketplaceManifest,
      originalMarketplace.replace(fixture.installation.claude.marketplace, "skill-router-000000000000000000000000"),
    );
    expectCaseFailure(() => installationCheck(fixture), /marketplace manifest name does not match/);
    writeFileSync(marketplaceManifest, originalMarketplace);

    const installationDocument = JSON.parse(readFileSync(fixture.installationFile, "utf8"));
    writeFileSync(fixture.installationFile, JSON.stringify({ ...installationDocument, owner: "someone-else" }, null, 2));
    expectCaseFailure(() => installationCheck(fixture), /does not carry router ownership/);
    writeFileSync(
      fixture.installationFile,
      JSON.stringify({ ...installationDocument, harnesses: ["opencode"] }, null, 2),
    );
    expectCaseFailure(() => installationCheck(fixture), /a claude case recorded/);
    writeFileSync(fixture.installationFile, `${JSON.stringify(installationDocument, null, 2)}\n`);
    assert.doesNotThrow(() => installationCheck(fixture));

    // Symlinks anywhere in the generated tree are a structural failure.
    symlinkSync(
      path.join(fixture.pluginDir, "skills", "release", "references", "steps.md"),
      path.join(fixture.pluginDir, "skills", "release", "link.md"),
    );
    expectCaseFailure(() => installationCheck(fixture), /generated plugin tree contains a symlink/);
    rmSync(path.join(fixture.pluginDir, "skills", "release", "link.md"), { force: true });
    assert.doesNotThrow(() => installationCheck(fixture));

    // The runner consumes production generation: it never re-implements it and
    // never mentions a test-only namespace or bridge root.
    const runnerSource = readFileSync(path.join(repoRoot, "scripts", "container-run-case.mjs"), "utf8");
    for (const forbidden of [
      "buildClaudeBridge",
      "expectedBridgeManifest",
      "assertBridgeMatchesManaged",
      "PLUGIN_MANIFEST_TEXT",
      "openagency-skill-router-harness",
      "/workspace/claude-bridge",
      "populateBridge",
    ]) {
      assert.ok(!runnerSource.includes(forbidden), `runner must not contain ${forbidden}`);
    }
    assert.ok(runnerSource.includes("loadProductionInstallation"), "runner loads the production installation module");
    assert.ok(runnerSource.includes("--harness"), "the packaged CLI is initialized with an explicit harness");
    assert.ok(
      runnerSource.includes('harness === "claude" ? "claude" : "opencode"'),
      "OpenCode cases pass --harness opencode and Claude cases pass --harness claude",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the pre-launch manifest snapshot fails closed on mutation, additions, and symlinks", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "skill-router-plugin-drift-"));
  try {
    const fixture = await generateProductionPlugin(root);
    const pluginDir = fixture.pluginDir;
    const before = pluginTreeManifest(pluginDir);
    assert.deepEqual(assertPluginTreeUnchanged(before, pluginDir), before, "unchanged plugin reproduces itself");

    // Byte mutation of a generated skill.
    const routerSkill = path.join(pluginDir, "skills", "skill-router", "SKILL.md");
    const original = readFileSync(routerSkill);
    writeFileSync(routerSkill, `${original}injected\n`);
    expectCaseFailure(
      () => assertPluginTreeUnchanged(before, pluginDir),
      /plugin manifest changed during the model run/,
      "a byte-level mutation is drift",
    );
    writeFileSync(routerSkill, original);
    assert.deepEqual(assertPluginTreeUnchanged(before, pluginDir), before, "restoring the bytes restores the proof");

    // Added file.
    writeFileSync(path.join(pluginDir, "skills", "skill-router", "extra.md"), "extra\n");
    expectCaseFailure(
      () => assertPluginTreeUnchanged(before, pluginDir),
      /plugin manifest changed during the model run/,
      "an added file is drift",
    );
    rmSync(path.join(pluginDir, "skills", "skill-router", "extra.md"), { force: true });

    // Added directory.
    mkdirSync(path.join(pluginDir, "skills", "rogue"), { recursive: true });
    expectCaseFailure(
      () => assertPluginTreeUnchanged(before, pluginDir),
      /plugin manifest changed during the model run/,
      "an added directory is drift",
    );
    rmSync(path.join(pluginDir, "skills", "rogue"), { recursive: true, force: true });

    // Removed support file.
    rmSync(path.join(pluginDir, "skills", "release", "references"), { recursive: true, force: true });
    expectCaseFailure(
      () => assertPluginTreeUnchanged(before, pluginDir),
      /plugin manifest changed during the model run/,
      "a dropped support file is drift",
    );
    await stageClaudePlugin(fixture.plan, fixture.state);
    assert.deepEqual(assertPluginTreeUnchanged(before, pluginDir), before, "regenerating restores the proof");

    // Symlink anywhere in the tree.
    symlinkSync(path.join(pluginDir, "skills", "skill-router", "SKILL.md"), path.join(pluginDir, "skills", "link.md"));
    expectCaseFailure(
      () => assertPluginTreeUnchanged(before, pluginDir),
      /generated plugin tree contains a symlink/,
    );
    rmSync(path.join(pluginDir, "skills", "link.md"), { force: true });

    // Removing the manifest snapshot fails closed instead of comparing nothing.
    expectCaseFailure(() => assertPluginTreeUnchanged(null, pluginDir), /plugin manifest snapshot is missing/);
    assert.deepEqual(assertPluginTreeUnchanged(before, pluginDir), before, "plugin tree is clean again");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the managed Claude policy surface must be absent before every launch", () => {
  assert.equal(MANAGED_POLICY_ROOT, "/etc/claude-code");
  assert.deepEqual(
    [...MANAGED_POLICY_ABSENT_PATHS],
    [
      "/etc/claude-code/managed-settings.json",
      "/etc/claude-code/managed-settings.d",
      "/etc/claude-code/managed-mcp.json",
      "/etc/claude-code/.claude",
    ],
  );
  assert.deepEqual([...MANAGED_POLICY_ABSENT_ENTRIES], ["managed-settings.json", "managed-settings.d", "managed-mcp.json", ".claude"]);

  // Absence passes without touching the real root.
  assert.equal(assertNoManagedClaudePolicy({ root: "/definitely-not-present/skill-router" }), true);
  for (const entry of MANAGED_POLICY_ABSENT_ENTRIES) {
    const target = path.join(MANAGED_POLICY_ROOT, entry);
    expectCaseFailure(
      () => assertNoManagedClaudePolicy({ exists: (candidate) => candidate === target }),
      new RegExp(`managed Claude policy surface is present.*${entry.replace(/\./g, "\\.")}`),
      `presence of ${entry} fails the case closed`,
    );
  }

  // The check is absence-only: it never creates or repairs anything.
  const root = mkdtempSync(path.join(os.tmpdir(), "skill-router-policy-"));
  try {
    assert.equal(assertNoManagedClaudePolicy({ root }), true);
    assert.deepEqual(readdirSync(root), [], "no writes under the policy root");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("system/init is held to the exact tool, MCP, and plugin contract", () => {
  const base = () => clone(fixture(FILES.claudeSelect)[0]);
  const initOf = (scenario) => clone(fixture(scenario === "control" ? FILES.claudeControl : FILES.claudeSelect)[0]);

  assert.equal(assertClaudeInitContract(base(), { scenario: "select" }), true, "pinned routed init passes");
  assert.equal(assertClaudeInitContract(initOf("control"), { scenario: "control" }), true, "pinned control init passes");

  // Exact model-callable tool set: Skill, Write, Bash — nothing more, nothing less.
  const missingTool = base();
  missingTool.tools = missingTool.tools.filter((name) => name !== "Bash");
  expectCaseFailure(() => assertClaudeInitContract(missingTool, { scenario: "select" }), /system\/init tools missing Bash/);

  const extraTool = base();
  extraTool.tools = [...extraTool.tools, "TodoWrite"];
  expectCaseFailure(
    () => assertClaudeInitContract(extraTool, { scenario: "select" }),
    /system\/init exposed unexpected tool\(s\): TodoWrite/,
    "no pinned extra tool is proven, so none is tolerated",
  );

  const mcpTool = base();
  mcpTool.tools = [...mcpTool.tools, "mcp__notes__search"];
  expectCaseFailure(() => assertClaudeInitContract(mcpTool, { scenario: "select" }), /system\/init exposed an MCP tool/);

  // MCP state: `mcp_servers` is reported and empty, and no mcp-shaped key or
  // `mcp__*` inventory entry may carry anything.
  const noServers = base();
  delete noServers.mcp_servers;
  expectCaseFailure(() => assertClaudeInitContract(noServers, { scenario: "select" }), /system\/init did not report mcp_servers/);

  const servers = base();
  servers.mcp_servers = ["notes"];
  expectCaseFailure(
    () => assertClaudeInitContract(servers, { scenario: "select" }),
    /system\/init reported MCP state under "mcp_servers"/,
  );

  const otherMcpKey = base();
  otherMcpKey.mcpServers = ["notes"];
  expectCaseFailure(
    () => assertClaudeInitContract(otherMcpKey, { scenario: "select" }),
    /system\/init reported MCP state under "mcpServers"/,
  );

  const mcpInventory = base();
  mcpInventory.slash_commands = ["/mcp__notes__search"];
  expectCaseFailure(
    () => assertClaudeInitContract(mcpInventory, { scenario: "select" }),
    /system\/init reported an MCP tool inventory under "slash_commands"/,
  );

  // Plugin state: omission is advisory, reported content must be exactly the
  // expected inline plugin (nothing at all for control).
  const omitted = base();
  delete omitted.plugins;
  assert.equal(assertClaudeInitContract(omitted, { scenario: "select" }), true, "omitted plugin state stays advisory");

  const emptyOnRouted = base();
  emptyOnRouted.plugins = [];
  expectCaseFailure(
    () => assertClaudeInitContract(emptyOnRouted, { scenario: "select" }),
    /system\/init did not report the expected inline plugin/,
  );

  const foreignPlugin = base();
  foreignPlugin.plugins = [{ name: "someone-elses-plugin", path: "builtin" }];
  expectCaseFailure(
    () => assertClaudeInitContract(foreignPlugin, { scenario: "select" }),
    /system\/init reported an unexpected plugin/,
  );

  const expectedOnControl = initOf("control");
  expectedOnControl.plugins = [...CLAUDE_BUILTIN_PLUGINS, { name: PLUGIN_NAME, path: PLUGIN_DIR }];
  expectCaseFailure(
    () => assertClaudeInitContract(expectedOnControl, { scenario: "control" }),
    /system\/init reported an unexpected plugin/,
    "control must not report the plugin",
  );

  const pluginErrors = base();
  pluginErrors.plugins = [{ name: PLUGIN_NAME, path: PLUGIN_DIR, error: "load failed" }];
  expectCaseFailure(() => assertClaudeInitContract(pluginErrors, { scenario: "select" }), /system\/init reported plugin errors/);

  const pluginOrigin = base();
  pluginOrigin.plugins = [{ name: PLUGIN_NAME, path: PLUGIN_DIR, marketplace: "public-registry" }];
  expectCaseFailure(
    () => assertClaudeInitContract(pluginOrigin, { scenario: "select" }),
    /system\/init reported a non-inline plugin origin/,
    "only this run's inline --plugin-dir plugin is acceptable",
  );

  const malformed = base();
  malformed.plugins = "enabled";
  expectCaseFailure(() => assertClaudeInitContract(malformed, { scenario: "select" }), /system\/init plugin state was malformed/);

  const otherPluginKey = base();
  otherPluginKey.pluginCount = 3;
  expectCaseFailure(
    () => assertClaudeInitContract(otherPluginKey, { scenario: "select" }),
    /system\/init reported plugin state under "pluginCount"/,
  );

  expectCaseFailure(() => assertClaudeInitContract(base(), { scenario: "sideways" }), /claude scenarios are control\/select\/none/);
  expectCaseFailure(() => assertClaudeInitContract(null, { scenario: "select" }), /system\/init event was not an object/);
});

test("claude prompts and skill uses use the exact canonical namespaced Skill IDs", () => {
  // The routed production expectation is the *production* plugin namespace
  // taken from the installed package, never a test-only harness namespace.
  assert.equal(PLUGIN_NAME, CLAUDE_PLUGINS.project);
  assert.equal(PLUGIN_NAME, "openagency-skill-router");
  assert.equal(CLAUDE_ROUTER_SKILL_ID, "openagency-skill-router:skill-router");
  assert.equal(CLAUDE_RELEASE_SKILL_ID, "openagency-skill-router:release");
  assert.equal(canonicalSkillId("release"), CLAUDE_RELEASE_SKILL_ID);
  assert.equal(CLAUDE_INIT_TOOLS.slice().sort().join(","), "Bash,Skill,Write");

  // Prompts name the canonical router ID; the bare public id never appears.
  for (const prompt of [CLAUDE_CONTROL_PROMPT, CLAUDE_SELECT_PROMPT, CLAUDE_NONE_PROMPT]) {
    assert.ok(prompt.includes(CLAUDE_ROUTER_SKILL_ID), `prompt names ${CLAUDE_ROUTER_SKILL_ID}`);
    assert.ok(!prompt.includes("the `skill-router` skill"), "no bare skill alias in a Claude prompt");
  }
  assert.ok(CLAUDE_CONTROL_PROMPT.includes("unavailable"), "control still stops when the skill cannot load");
  // OpenCode prompts keep the bare public id (no plugin namespace there).
  assert.ok(OPENCODE_SELECT_PROMPT.includes("`skill-router`"));

  // The routed fixtures prove the canonical chain and the public route id.
  const select = inspectClaudeRun(toStdout(fixture(FILES.claudeSelect)), { scenario: "select", request: SELECT_REQUEST });
  assert.equal(select.skillId, "release", "route output skillId stays the public id");
  assert.deepEqual(select.chain, expectedCaseChain("claude", "select"));

  // A bare alias that succeeds is rejected in every scenario.
  const bareRouter = clone(fixture(FILES.claudeSelect));
  toolInputOf(bareRouter, "t1").skill = ROUTER_SKILL_ID;
  expectCaseFailure(
    () => inspectClaudeRun(toStdout(bareRouter), { scenario: "select", request: SELECT_REQUEST }),
    /bare skill alias was loaded instead of the canonical plugin skill id/,
  );

  const bareRelease = clone(fixture(FILES.claudeSelect));
  toolInputOf(bareRelease, "t4").skill = RELEASE_SKILL_ID;
  expectCaseFailure(
    () => inspectClaudeRun(toStdout(bareRelease), { scenario: "select", request: SELECT_REQUEST }),
    /bare skill alias was loaded instead of the canonical plugin skill id/,
  );

  // A bare alias that *fails* proves nothing and never satisfies the chain.
  const bareFailed = clone(fixture(FILES.claudeSelect));
  toolInputOf(bareFailed, "t1").skill = ROUTER_SKILL_ID;
  toolResultOf(bareFailed, "t1").is_error = true;
  expectCaseFailure(
    () => inspectClaudeRun(toStdout(bareFailed), { scenario: "select", request: SELECT_REQUEST }),
    /router skill was never loaded with a successful tool_result/,
  );

  // Any unexpected plugin skill name fails closed.
  const unexpectedName = clone(fixture(FILES.claudeSelect));
  toolInputOf(unexpectedName, "t1").skill = `${PLUGIN_NAME}:helper`;
  expectCaseFailure(
    () => inspectClaudeRun(toStdout(unexpectedName), { scenario: "select", request: SELECT_REQUEST }),
    /unexpected plugin skill name\/use/,
  );

  const foreignPlugin = clone(fixture(FILES.claudeSelect));
  toolInputOf(foreignPlugin, "t1").skill = "other-plugin:skill-router";
  expectCaseFailure(
    () => inspectClaudeRun(toStdout(foreignPlugin), { scenario: "select", request: SELECT_REQUEST }),
    /unexpected plugin skill name\/use/,
  );

  const nameless = clone(fixture(FILES.claudeSelect));
  delete toolInputOf(nameless, "t1").skill;
  expectCaseFailure(
    () => inspectClaudeRun(toStdout(nameless), { scenario: "select", request: SELECT_REQUEST }),
    /skill use carried no skill name/,
  );

  // Control attempts the canonical ID and requires a correlated error.
  const control = inspectClaudeRun(toStdout(fixture(FILES.claudeControl)), { scenario: "control" });
  assert.deepEqual(control.chain, ["router-unavailable"]);

  const controlLoaded = clone(fixture(FILES.claudeControl));
  toolResultOf(controlLoaded, "t1").is_error = false;
  expectCaseFailure(
    () => inspectClaudeRun(toStdout(controlLoaded), { scenario: "control" }),
    /router skill loaded without the plugin/,
  );

  // Control inventory that names the plugin skills is discoverability proof.
  const controlInventory = clone(fixture(FILES.claudeControl));
  controlInventory[0].skills = { [CLAUDE_ROUTER_SKILL_ID]: ["router"] };
  expectCaseFailure(
    () => inspectClaudeRun(toStdout(controlInventory), { scenario: "control" }),
    /router skill was discoverable without the plugin/,
  );
  const controlReleaseInventory = clone(fixture(FILES.claudeControl));
  controlReleaseInventory[0].skills = { [CLAUDE_RELEASE_SKILL_ID]: ["release"] };
  expectCaseFailure(
    () => inspectClaudeRun(toStdout(controlReleaseInventory), { scenario: "control" }),
    /release skill was discoverable without the plugin/,
  );

  // A routed run whose init omits the inventory still proves discovery through
  // the correlated successful Skill result (inventory omission is advisory).
  const omittedInventory = clone(fixture(FILES.claudeSelect));
  delete omittedInventory[0].skills;
  const omittedResult = inspectClaudeRun(toStdout(omittedInventory), { scenario: "select", request: SELECT_REQUEST });
  assert.deepEqual(omittedResult.chain, expectedCaseChain("claude", "select"));
});

test("claude successful calls are limited to one exact token write and the managed route", () => {
  const sessionId = "11111111-2222-3333-4444-555555555555";
  const assistant = (id, name, input) => ({
    type: "assistant",
    session_id: sessionId,
    message: { content: [{ type: "tool_use", id, name, input }] },
  });
  const toolResult = (id, content = "ok") => ({
    type: "user",
    session_id: sessionId,
    message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: false }] },
  });

  // A second successful Write is rejected even when it targets nothing.
  const twoWrites = clone(fixture(FILES.claudeSelect));
  const routeIndex = twoWrites.findIndex((event) =>
    Array.isArray(event.message?.content) && event.message.content.some((block) => block.type === "tool_use" && block.name === "Bash"),
  );
  twoWrites.splice(routeIndex, 0, assistant("tX", "Write", { file_path: "/workspace/project/notes.md", content: "x" }), toolResult("tX"));
  expectCaseFailure(
    () => inspectClaudeRun(toStdout(twoWrites), { scenario: "select", request: SELECT_REQUEST }),
    /more than one successful Write tool call was observed/,
  );

  // A successful Write into the generated plugin is rejected by name.
  const pluginWrite = clone(fixture(FILES.claudeSelect));
  toolInputOf(pluginWrite, "t2").file_path = "/workspace/project/.skill-router/claude/plugins/openagency-skill-router/skills/release/SKILL.md";
  expectCaseFailure(
    () => inspectClaudeRun(toStdout(pluginWrite), { scenario: "select", request: SELECT_REQUEST }),
    /a successful Write targeted the generated plugin/,
  );

  // The single successful Write must be the request token file.
  const otherWrite = clone(fixture(FILES.claudeSelect));
  toolInputOf(otherWrite, "t2").file_path = "/workspace/project/notes.md";
  expectCaseFailure(
    () => inspectClaudeRun(toStdout(otherWrite), { scenario: "select", request: SELECT_REQUEST }),
    /the successful Write did not target the request token file/,
  );

  // ... with the exact request bytes.
  const wrongContent = clone(fixture(FILES.claudeSelect));
  toolInputOf(wrongContent, "t2").content = "prepare the release notes";
  expectCaseFailure(
    () => inspectClaudeRun(toStdout(wrongContent), { scenario: "select", request: SELECT_REQUEST }),
    /request token file content did not match the exact request bytes/,
  );

  // No successful Write may satisfy the chain if it fails.
  const failedWrite = clone(fixture(FILES.claudeSelect));
  toolResultOf(failedWrite, "t2").is_error = true;
  expectCaseFailure(
    () => inspectClaudeRun(toStdout(failedWrite), { scenario: "select", request: SELECT_REQUEST }),
    /request token file was not written/,
  );

  // Every successful Bash call is the exact managed route invocation.
  const offRoute = clone(fixture(FILES.claudeSelect));
  toolInputOf(offRoute, "t3").command = "ls -la";
  expectCaseFailure(
    () => inspectClaudeRun(toStdout(offRoute), { scenario: "select", request: SELECT_REQUEST }),
    /a successful Bash tool call was not the managed route invocation/,
  );

  const wrappedRoute = clone(fixture(FILES.claudeSelect));
  toolInputOf(wrappedRoute, "t3").command =
    "sudo skill-router route --json --root . --request-token 0123456789abcdef0123456789abcdef";
  expectCaseFailure(
    () => inspectClaudeRun(toStdout(wrappedRoute), { scenario: "select", request: SELECT_REQUEST }),
    /a successful Bash tool call was not the managed route invocation/,
  );

  const wrongToken = clone(fixture(FILES.claudeSelect));
  toolInputOf(wrongToken, "t3").command = "skill-router route --json --root . --request-token ffffffff00000000ffffffff00000000";
  expectCaseFailure(
    () => inspectClaudeRun(toStdout(wrongToken), { scenario: "select", request: SELECT_REQUEST }),
    /route command token did not match the written request token/,
  );

  // The route may not precede the token write.
  const outOfOrder = clone(fixture(FILES.claudeSelect));
  const bashEventIndex = outOfOrder.findIndex((event) =>
    Array.isArray(event.message?.content) && event.message.content.some((block) => block.type === "tool_use" && block.name === "Bash"),
  );
  const bashPair = outOfOrder[bashEventIndex];
  const bashResult = outOfOrder[bashEventIndex + 1];
  outOfOrder.splice(bashEventIndex, 2);
  const writeEventIndex = outOfOrder.findIndex((event) =>
    Array.isArray(event.message?.content) && event.message.content.some((block) => block.type === "tool_use" && block.name === "Write"),
  );
  outOfOrder.splice(writeEventIndex, 0, bashPair, bashResult);
  expectCaseFailure(
    () => inspectClaudeRun(toStdout(outOfOrder), { scenario: "select", request: SELECT_REQUEST }),
    /route invocation preceded the request token write/,
  );

  // Any mcp__* tool use fails closed, whatever the init reported.
  const mcpUse = clone(fixture(FILES.claudeSelect));
  const mcpAt = mcpUse.findIndex((event) => event.type === "assistant");
  mcpUse.splice(mcpAt, 0, assistant("tM", "mcp__notes__search", { query: "release" }), toolResult("tM"));
  expectCaseFailure(
    () => inspectClaudeRun(toStdout(mcpUse), { scenario: "select", request: SELECT_REQUEST }),
    /an MCP tool use was observed/,
  );
  const mcpInit = clone(fixture(FILES.claudeSelect));
  mcpInit[0].tools = [...mcpInit[0].tools, "mcp__notes__search"];
  mcpInit.splice(mcpAt, 0, assistant("tM", "mcp__notes__search", { query: "release" }), toolResult("tM"));
  expectCaseFailure(
    () => inspectClaudeRun(toStdout(mcpInit), { scenario: "select", request: SELECT_REQUEST }),
    /system\/init exposed an MCP tool/,
    "the init contract fails before any tool use is considered",
  );

  // The clean fixture still proves the full chain with exactly one Write/Bash.
  const clean = inspectClaudeRun(toStdout(fixture(FILES.claudeSelect)), { scenario: "select", request: SELECT_REQUEST });
  assert.deepEqual(clean.chain, expectedCaseChain("claude", "select"));
  assert.equal(clean.skillId, "release");
});

test("Claude holds the request write to the stable spool and rejects every shell reference", () => {
  const spoolToken = "0123456789abcdef0123456789abcdef";

  // The retired legacy spool is detected and never accepted as proof.
  const legacyWrite = clone(fixture(FILES.claudeSelect));
  toolInputOf(legacyWrite, "t2").file_path = `/workspace/project/.skill-router/requests/${spoolToken}.txt`;
  expectCaseFailure(
    () => inspectClaudeRun(toStdout(legacyWrite), { scenario: "select", request: SELECT_REQUEST }),
    /request token file was written to the retired requests directory/,
  );

  // A nested/copy directory carrying the stable spool name is still rejected.
  const nestedWrite = clone(fixture(FILES.claudeSelect));
  toolInputOf(nestedWrite, "t2").file_path = `/workspace/project/copy/.skill-router-requests/${spoolToken}.txt`;
  expectCaseFailure(
    () => inspectClaudeRun(toStdout(nestedWrite), { scenario: "select", request: SELECT_REQUEST }),
    /request token file was written outside the project/,
  );

  // Any Bash command naming either spool fails structurally, before the
  // managed-route contract is even considered.
  const shellForms = [
    `printf x > /workspace/project/.skill-router-requests/${spoolToken}.txt`,
    `printf x > .skill-router-requests\\${spoolToken}.txt`,
    `printf x > /workspace/project/.skill-router/requests/${spoolToken}.txt`,
    `printf x > ".skill-router/requests/${spoolToken}.txt"`,
  ];
  const sessionId = clone(fixture(FILES.claudeSelect))[0].session_id;
  for (const command of shellForms) {
    const events = clone(fixture(FILES.claudeSelect));
    events.splice(1, 0,
      { type: "assistant", session_id: sessionId, message: { content: [{ type: "tool_use", id: "tS", name: "Bash", input: { command } }] } },
      { type: "user", session_id: sessionId, message: { content: [{ type: "tool_result", tool_use_id: "tS", content: "ok", is_error: false }] } },
    );
    expectCaseFailure(
      () => inspectClaudeRun(toStdout(events), { scenario: "select", request: SELECT_REQUEST }),
      /shell command attempted to write the request file/,
    );
  }

  // The untouched fixture still proves the stable-spool chain.
  const clean = inspectClaudeRun(toStdout(fixture(FILES.claudeSelect)), { scenario: "select", request: SELECT_REQUEST });
  assert.deepEqual(clean.chain, expectedCaseChain("claude", "select"));
});

test("the harness parseArgs still accepts comma-separated list values", () => {
  const options = parseArgs([
    "run",
    "--case=claude-select,claude-none",
    "--harness",
    "claude",
    "--network=none",
    "--secret-env=CLAUDE_CODE_OAUTH_TOKEN,ANTHROPIC_API_KEY",
  ]);
  assert.deepEqual(options.errors, []);
  assert.deepEqual(options.caseIds, ["claude-select", "claude-none"], "--case=a,b splits into two case ids");
  assert.deepEqual(options.harnessIds, ["claude"], "space-separated list form still works");
  assert.equal(options.network, "none");
  assert.deepEqual(options.secretEnv, ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]);
  assert.equal(options.command, "run");

  const withSpaces = parseArgs(["run", "--case", " claude-select , claude-none "]);
  assert.deepEqual(withSpaces.caseIds, ["claude-select", "claude-none"], "surrounding whitespace is trimmed per entry");
  assert.deepEqual(withSpaces.errors, []);
});

/* ---------- OpenCode credential transport (auth-bridge remediation) --------- */

function writeAuthFixture(root, name, content, mode = 0o600) {
  const target = path.join(root, name);
  writeFileSync(target, typeof content === "string" ? content : `${JSON.stringify(content)}\n`, { mode });
  chmodSync(target, mode);
  return target;
}

test("preflight picks env or provider-filtered snapshot auth — and only supported providers", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "skill-router-preflight-auth-"));
  try {
    const openaiFile = writeAuthFixture(root, "openai.json", {
      openai: { type: "api", key: "sk-dummy-openai-000000000000000000000000" },
    });
    const goFile = writeAuthFixture(root, "go.json", {
      "opencode-go": { type: "api", key: "sk-dummy-opencode-go-000000000000000000" },
    });
    const mixedFile = writeAuthFixture(root, "mixed.json", {
      openai: { type: "api", key: "sk-dummy-openai-000000000000000000000000" },
      "opencode-go": { type: "api", key: "sk-dummy-opencode-go-000000000000000000" },
    });

    // Snapshot mode: the explicitly supplied file carries the provider.
    const openai = preflightLiveCases({
      manifest,
      env: { SKILL_ROUTER_OPENCODE_MODEL: "openai/gpt-test-model" },
      caseIds: ["opencode-v1-select"],
      selectedSecretNames: [],
      authFile: openaiFile,
    });
    assert.equal(openai.auth.mode, "snapshot");
    assert.equal(openai.auth.provider, "openai");
    assert.deepEqual([...openai.auth.snapshot.supported], ["openai"]);
    assert.ok(openai.notes.some((note) => note.includes("openai") && note.includes("auth snapshot")));

    // opencode-go has no mapped key: only a file can satisfy it.
    const go = preflightLiveCases({
      manifest,
      env: { SKILL_ROUTER_OPENCODE_MODEL: "opencode-go/some-model" },
      caseIds: ["opencode-v2-select"],
      selectedSecretNames: [],
      authFile: goFile,
    });
    assert.equal(go.auth.mode, "snapshot");
    assert.equal(go.auth.provider, "opencode-go");

    // A file that does not carry the provider never satisfies it.
    assert.throws(
      () =>
        preflightLiveCases({
          manifest,
          env: { SKILL_ROUTER_OPENCODE_MODEL: "openai/gpt-test-model" },
          caseIds: ["opencode-v1-select"],
          selectedSecretNames: [],
          authFile: goFile,
        }),
      /requires --secret-env OPENAI_API_KEY/,
    );

    // Unknown/unsupported providers never become supported via a file.
    for (const model of ["acme/model", "google/gemini-pro"]) {
      assert.throws(
        () =>
          preflightLiveCases({
            manifest,
            env: { SKILL_ROUTER_OPENCODE_MODEL: model },
            caseIds: ["opencode-v1-select"],
            selectedSecretNames: [],
            authFile: mixedFile,
          }),
        /unsupported OpenCode provider/,
        `${model} stays unsupported`,
      );
    }

    // Mapped providers still need their own key when the file lacks them.
    assert.throws(
      () =>
        preflightLiveCases({
          manifest,
          env: { SKILL_ROUTER_OPENCODE_MODEL: "openrouter/org/model" },
          caseIds: ["opencode-v1-select"],
          selectedSecretNames: [],
          authFile: mixedFile,
        }),
      /requires --secret-env OPENROUTER_API_KEY/,
    );

    // No file at all: the mapped key is required.
    assert.throws(
      () =>
        preflightLiveCases({
          manifest,
          env: { SKILL_ROUTER_OPENCODE_MODEL: "openai/gpt-test-model" },
          caseIds: ["opencode-v1-select"],
          selectedSecretNames: [],
        }),
      /requires --secret-env OPENAI_API_KEY/,
    );

    // Claude-only preflight never consults (and never reads) the auth file.
    const claudeOnly = preflightLiveCases({
      manifest,
      env: { SKILL_ROUTER_CLAUDE_MODEL: "sonnet", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-live-0123456789abcdef" },
      caseIds: ["claude-control"],
      selectedSecretNames: ["CLAUDE_CODE_OAUTH_TOKEN"],
      authFile: path.join(root, "must-not-be-read.json"),
    });
    assert.deepEqual(claudeOnly.cases, ["claude-control"]);
    assert.deepEqual(claudeOnly.auth, { mode: "none", provider: null, snapshot: null });
    assert.ok(!claudeOnly.notes.some((note) => note.includes("auth snapshot")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a usable mapped key wins over an explicit auth file and the file is never read", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "skill-router-env-auth-"));
  try {
    const missing = path.join(root, "must-not-be-read.json");
    const validFile = writeAuthFixture(root, "openai.json", {
      openai: { type: "api", key: "sk-dummy-openai-000000000000000000000000" },
    });
    const envBase = {
      SKILL_ROUTER_OPENCODE_MODEL: "openai/gpt-test-model",
      OPENAI_API_KEY: "sk-openai-live-0123456789",
    };

    // 1) Env precedence: a usable selected key is chosen and the (missing!)
    //    file is never touched.
    const envMode = preflightLiveCases({
      manifest,
      env: envBase,
      caseIds: ["opencode-v1-select"],
      selectedSecretNames: ["OPENAI_API_KEY"],
      authFile: missing,
    });
    assert.equal(envMode.auth.mode, "environment");
    assert.equal(envMode.auth.provider, "openai");
    assert.equal(envMode.auth.snapshot, null, "no snapshot descriptor in env mode");
    assert.ok(
      envMode.notes.some((note) => note.includes("environment key") && note.includes("no OpenCode credential file")),
      "env mode documents that no file is read",
    );

    // 2) A selected-but-unusable key is an error, never a silent fallback to
    //    the supplied file (which would otherwise be read).
    assert.throws(
      () =>
        preflightLiveCases({
          manifest,
          env: { ...envBase, OPENAI_API_KEY: "short" },
          caseIds: ["opencode-v1-select"],
          selectedSecretNames: ["OPENAI_API_KEY"],
          authFile: validFile,
        }),
      /OPENAI_API_KEY must be set in the host environment with at least 8 characters/,
    );

    // 3) Through the production runner: env mode reaches the Docker probe with
    //    a nonexistent auth file, proving zero reads and zero snapshots.
    const { runner, calls } = recordingRunner({ PATH: process.env.PATH ?? "", ...envBase }, { opencodeAuthFile: missing });
    assert.throws(
      () => runner.run({ harnessIds: ["opencode-v1"], secretEnv: ["OPENAI_API_KEY"] }),
      (error) => error instanceof PlanError && /Docker is configured for|daemon is not reachable/.test(error.message),
      "env-backed auth passes preflight without touching the file",
    );
    assert.ok(calls.length > 0, "only Docker probes run after a satisfied credential gate");
    assert.ok(!calls.some((argv) => argv.join(" ").includes("must-not-be-read")), "the file path never reaches a command");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an OAuth snapshot credential may run one OpenCode case but never a multi-case selection", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "skill-router-oauth-policy-"));
  try {
    const oauthFile = writeAuthFixture(root, "oauth.json", {
      openai: {
        type: "oauth",
        accessToken: "sk-dummy-access-0123456789",
        refreshToken: "sk-dummy-refresh-0123456789",
        expiresAt: 4102444800000,
      },
    });
    const apiFile = writeAuthFixture(root, "api.json", {
      "opencode-go": { type: "api", key: "sk-dummy-opencode-go-000000000000000000" },
    });
    const oauthDescriptor = resolveOpenCodeAuthFile({ requested: oauthFile });
    const apiDescriptor = resolveOpenCodeAuthFile({ requested: apiFile });
    assert.equal(oauthDescriptor.entries.find((entry) => entry.id === "openai").type, "oauth");
    assert.equal(apiDescriptor.entries.find((entry) => entry.id === "opencode-go").type, "api");

    // Exactly one filtered OpenCode case: permitted, with an explicit note.
    const single = preflightLiveCases({
      manifest,
      env: { SKILL_ROUTER_OPENCODE_MODEL: "openai/gpt-test-model" },
      caseIds: ["opencode-v1-select"],
      selectedSecretNames: [],
      authFile: oauthFile,
    });
    assert.equal(single.models.opencode, "openai/gpt-test-model");
    assert.ok(
      single.notes.some((note) => note.includes("OAuth") && note.includes("exactly one OpenCode case")),
      "the single-case OAuth allowance is documented",
    );

    // Two filtered OpenCode cases: rejected before any subprocess.
    assert.throws(
      () =>
        preflightLiveCases({
          manifest,
          env: { SKILL_ROUTER_OPENCODE_MODEL: "openai/gpt-test-model" },
          caseIds: ["opencode-v1-select", "opencode-v1-none"],
          selectedSecretNames: [],
          authFile: oauthFile,
        }),
      (error) =>
        error instanceof PlanError &&
        /OAuth credential in the auth snapshot, but 2 OpenCode cases are selected/.test(error.message) &&
        error.message.includes("refresh-token rotation") &&
        error.message.includes('type "api"'),
      "multi-case OAuth selection is rejected with the rotation rationale",
    );

    // Full OpenCode selection (both harnesses = four cases): rejected.
    assert.throws(
      () =>
        preflightLiveCases({
          manifest,
          env: { SKILL_ROUTER_OPENCODE_MODEL: "openai/gpt-test-model" },
          harnessIds: ["opencode-v1", "opencode-v2"],
          selectedSecretNames: [],
          authFile: oauthFile,
        }),
      /OAuth credential in the auth snapshot, but 4 OpenCode cases are selected/,
    );

    // Zero subprocesses through the production runner for a multi-case OAuth run.
    {
      const { runner, calls } = recordingRunner(
        { PATH: process.env.PATH ?? "", SKILL_ROUTER_OPENCODE_MODEL: "openai/gpt-test-model" },
        { opencodeAuthFile: oauthFile },
      );
      assert.throws(
        () => runner.run({ caseIds: ["opencode-v1-select", "opencode-v1-none"], secretEnv: [] }),
        /OAuth credential in the auth snapshot/,
      );
      assert.equal(calls.length, 0, "OAuth policy rejects before any subprocess");
    }

    // API credentials may still run the full OpenCode selection (preflight
    // passes; the run then stops at the Docker probe, not at credentials).
    {
      const { runner, calls } = recordingRunner(
        { PATH: process.env.PATH ?? "", SKILL_ROUTER_OPENCODE_MODEL: "opencode-go/some-model" },
        { opencodeAuthFile: apiFile },
      );
      assert.throws(
        () => runner.run({ harnessIds: ["opencode-v1", "opencode-v2"], secretEnv: [] }),
        (error) => error instanceof PlanError && /Docker is configured for|daemon is not reachable/.test(error.message),
        "an API snapshot credential passes preflight for all four OpenCode cases",
      );
      assert.ok(calls.length > 0);
    }

    // Env API-key mode stays an alternative for multi-case runs (no snapshot).
    {
      const { runner, calls } = recordingRunner(
        {
          PATH: process.env.PATH ?? "",
          SKILL_ROUTER_OPENCODE_MODEL: "openai/gpt-test-model",
          OPENAI_API_KEY: "sk-openai-live-0123456789",
        },
        {},
      );
      assert.throws(
        () => runner.run({ harnessIds: ["opencode-v1", "opencode-v2"], secretEnv: ["OPENAI_API_KEY"] }),
        (error) => error instanceof PlanError && /Docker is configured for|daemon is not reachable/.test(error.message),
        "the mapped env key path is unaffected by the OAuth policy",
      );
      assert.ok(calls.length > 0);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Claude-only runs never read the auth file; OpenCode failures happen with zero subprocesses", () => {
  const missingPath = path.join(repoRoot, "does-not-exist-opencode-auth.json");
  const root = mkdtempSync(path.join(os.tmpdir(), "skill-router-case-auth-"));
  try {
    // Claude-only: a missing/unsafe path is never read (it would otherwise fail).
    {
      const { runner, calls } = recordingRunner(
        {
          PATH: process.env.PATH ?? "",
          SKILL_ROUTER_CLAUDE_MODEL: "sonnet",
          CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-live-0123456789abcdef",
        },
        { opencodeAuthFile: missingPath },
      );
      assert.throws(
        () => runner.run({ harnessIds: ["claude"], secretEnv: ["CLAUDE_CODE_OAUTH_TOKEN"] }),
        (error) => error instanceof PlanError && /Docker is configured for|daemon is not reachable/.test(error.message),
      );
      assert.ok(calls.length > 0, "the run reached the Docker probe, not an auth-file error");
      assert.ok(!calls.some((argv) => argv.join(" ").includes("does-not-exist-opencode-auth")), "the auth path never reaches a command");
    }

    // OpenCode selection + missing file: hard failure before any subprocess.
    {
      const { runner, calls } = recordingRunner(
        { PATH: process.env.PATH ?? "", SKILL_ROUTER_OPENCODE_MODEL: "openai/gpt-test-model" },
        { opencodeAuthFile: missingPath },
      );
      assert.throws(() => runner.run({ harnessIds: ["opencode-v1"], secretEnv: [] }), /does not exist/);
      assert.equal(calls.length, 0, "zero subprocesses for a missing auth file");
    }

    // Unsafe permissions: hard failure before any subprocess, path withheld.
    {
      const loose = writeAuthFixture(root, "loose.json", { openai: { type: "api", key: "sk-dummy-value-0123456789" } }, 0o644);
      const { runner, calls } = recordingRunner(
        { PATH: process.env.PATH ?? "", SKILL_ROUTER_OPENCODE_MODEL: "openai/gpt-test-model" },
        { opencodeAuthFile: loose },
      );
      assert.throws(
        () => runner.run({ harnessIds: ["opencode-v1"], secretEnv: [] }),
        (error) => error instanceof PlanError && /owner-only/.test(error.message) && !error.message.includes(root),
      );
      assert.equal(calls.length, 0, "zero subprocesses for an unsafe auth file");
    }

    // Provider mismatch: snapshot carries openai only, model needs openrouter.
    {
      const snapshotFile = writeAuthFixture(root, "snapshot.json", {
        openai: { type: "api", key: "sk-dummy-value-0123456789" },
        "opencode-go": { type: "api", key: "sk-dummy-opencode-go-000000000000000000" },
      });
      const descriptor = resolveOpenCodeAuthFile({ requested: snapshotFile });
      assert.deepEqual([...descriptor.supported], ["openai", "opencode-go"]);
      assert.equal(descriptor.importEntries.length, 2, "both supported providers convert into import entries");
      const { runner, calls } = recordingRunner(
        { PATH: process.env.PATH ?? "", SKILL_ROUTER_OPENCODE_MODEL: "openrouter/org/model" },
        { opencodeAuthFile: snapshotFile },
      );
      assert.throws(
        () => runner.run({ harnessIds: ["opencode-v1"], secretEnv: [] }),
        /requires --secret-env OPENROUTER_API_KEY/,
      );
      assert.equal(calls.length, 0, "provider mismatch fails before pack/build/probe/container");
    }

    // Positive control: a valid snapshot for the model's provider gets past the
    // credential gate (the run then stops at the Docker probe, not preflight).
    {
      const snapshotFile = writeAuthFixture(root, "valid.json", {
        openai: { type: "api", key: "sk-dummy-value-0123456789" },
      });
      const { runner, calls } = recordingRunner(
        { PATH: process.env.PATH ?? "", SKILL_ROUTER_OPENCODE_MODEL: "openai/gpt-test-model" },
        { opencodeAuthFile: snapshotFile },
      );
      assert.throws(
        () => runner.run({ harnessIds: ["opencode-v1"], secretEnv: [] }),
        (error) => error instanceof PlanError && /Docker is configured for|daemon is not reachable/.test(error.message),
        "credential preflight passed with the snapshot and no env key",
      );
      assert.ok(calls.length > 0);
      assert.ok(!calls.some((argv) => argv.join(" ").includes(snapshotFile)), "the original auth file never reaches a command");
      assert.ok(!calls.some((argv) => argv.join(" ").includes("sk-dummy-value-0123456789")), "values never reach a command");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("container credential setup stages v1 legacy and imports v2, always requiring a listing", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "skill-router-stage-auth-"));
  try {
    const mount = path.join(root, "opencode-credential");
    mkdirSync(mount, { recursive: true, mode: 0o700 });
    chmodSync(mount, 0o700);
    const legacyFile = writeAuthFixture(mount, OPENCODE_AUTH_LEGACY, {
      openai: { type: "api", key: "sk-dummy-openai-000000000000000000000000" },
    });
    const importFile = writeAuthFixture(mount, OPENCODE_AUTH_IMPORT, [
      {
        id: "a".repeat(64),
        integrationID: "openai",
        label: "API key",
        active: true,
        value: { type: "key", key: "sk-dummy-openai-000000000000000000000000" },
      },
    ]);
    const xdg = path.join(root, "xdg");
    mkdirSync(xdg, { recursive: true });
    const listed = { error: null, status: 0, output: "OpenAI api" };
    const empty = { error: null, status: 0, output: "No authenticated integrations" };

    // v1 stages the legacy file byte-exactly and never runs the v2 importer.
    assert.throws(
      () => setupOpenCodeAuth({ provider: "openai", harness: "opencode-v1", env: { XDG_DATA_HOME: xdg }, mount, listAuth: () => empty }),
      /does not recognize the configured provider/,
      "an empty listing is never accepted",
    );
    const seenV1Args = [];
    let v1Imports = 0;
    const v1 = setupOpenCodeAuth({
      provider: "openai",
      harness: "opencode-v1",
      env: { XDG_DATA_HOME: xdg },
      mount,
      listAuth: ({ args }) => {
        seenV1Args.push(args.join(" "));
        return listed;
      },
      importAuth: () => {
        v1Imports += 1;
        return { error: null, status: 0 };
      },
    });
    assert.deepEqual(v1, { mode: "snapshot", provider: "openai", recognition: "listed" });
    assert.deepEqual(seenV1Args, ["auth list"], "v1 lists without the v2-only standalone flag");
    assert.equal(v1Imports, 0, "v1 never runs the v2 importer");
    const staged = path.join(xdg, OPENCODE_AUTH_DATA);
    assert.equal(statSync(staged).mode & 0o077, 0, "staged legacy file is owner-only");
    assert.deepEqual(readFileSync(staged), readFileSync(legacyFile), "staged bytes are identical to the mount");

    // v2 imports the generated file with --standalone, then lists standalone.
    rmSync(xdg, { recursive: true, force: true });
    mkdirSync(xdg, { recursive: true });
    const seenImports = [];
    const seenV2Args = [];
    const v2 = setupOpenCodeAuth({
      provider: "openai",
      harness: "opencode-v2",
      env: { XDG_DATA_HOME: xdg },
      mount,
      importAuth: ({ file }) => {
        seenImports.push(file);
        return { error: null, status: 0 };
      },
      listAuth: ({ args }) => {
        seenV2Args.push(args.join(" "));
        return { error: null, status: 0, output: "OpenAI API key stored" };
      },
    });
    assert.deepEqual(v2, { mode: "snapshot", provider: "openai", recognition: "listed" });
    assert.deepEqual(seenImports, [importFile], "the generated import file is what gets imported");
    assert.deepEqual(seenV2Args, ["auth list --standalone"], "v2 lists with --standalone");
    assert.equal(existsSync(path.join(xdg, OPENCODE_AUTH_DATA)), false, "v2 never stages the legacy file");

    // v2 failures: import start error, nonzero status, empty listing — and raw
    // output never crosses the boundary.
    const importFail = { provider: "openai", harness: "opencode-v2", env: { XDG_DATA_HOME: xdg }, mount, listAuth: () => listed };
    assert.throws(
      () => setupOpenCodeAuth({ ...importFail, importAuth: () => ({ error: { code: "ENOENT" }, status: null }) }),
      /auth import failed to start/,
    );
    assert.throws(
      () => setupOpenCodeAuth({ ...importFail, importAuth: () => ({ error: null, status: 1 }) }),
      /auth import exited with status 1/,
    );
    const leaky = "SECRET-ACCOUNT-LABEL sk-dummy-openai-000000000000000000000000 /home/node/.local/share/opencode/auth.json";
    assert.throws(
      () =>
        setupOpenCodeAuth({
          ...importFail,
          importAuth: () => ({ error: null, status: 1, stderr: leaky, stdout: leaky }),
        }),
      (error) =>
        error instanceof CaseAssertionError &&
        /auth import exited with status 1/.test(error.message) &&
        !error.message.includes("SECRET-ACCOUNT-LABEL") &&
        !error.message.includes("sk-dummy-openai"),
      "import failures never echo harness output",
    );
    assert.throws(
      () =>
        setupOpenCodeAuth({
          ...importFail,
          importAuth: () => ({ error: null, status: 0, stderr: leaky, stdout: leaky }),
          listAuth: () => ({ error: null, status: 1, output: leaky, stderr: leaky }),
        }),
      (error) =>
        error instanceof CaseAssertionError &&
        /auth list exited with status 1/.test(error.message) &&
        !error.message.includes("SECRET-ACCOUNT-LABEL") &&
        !error.message.includes("sk-dummy-openai"),
      "list failures never echo harness output",
    );
    assert.throws(
      () =>
        setupOpenCodeAuth({
          ...importFail,
          importAuth: () => ({ error: null, status: 0 }),
          listAuth: () => ({ error: null, status: 0, output: "" }),
        }),
      /does not recognize the configured provider/,
      "an empty v2 listing is never accepted",
    );

    // Missing/unsafe mounted files and a missing XDG root.
    assert.throws(
      () =>
        setupOpenCodeAuth({
          provider: "openai",
          harness: "opencode-v2",
          env: { XDG_DATA_HOME: xdg },
          mount: path.join(root, "absent-credential-dir"),
          importAuth: () => ({ error: null, status: 0 }),
          listAuth: () => listed,
        }),
      /is missing from the container mount/,
    );
    chmodSync(importFile, 0o644);
    assert.throws(
      () => setupOpenCodeAuth({ provider: "openai", harness: "opencode-v2", env: { XDG_DATA_HOME: xdg }, mount, importAuth: () => ({ error: null, status: 0 }), listAuth: () => listed }),
      /owner-only/,
    );
    chmodSync(importFile, 0o600);
    assert.throws(
      () => setupOpenCodeAuth({ provider: "openai", harness: "opencode-v1", env: {}, mount, listAuth: () => listed }),
      /XDG_DATA_HOME/,
    );
    chmodSync(legacyFile, 0o664);
    assert.throws(
      () => setupOpenCodeAuth({ provider: "openai", harness: "opencode-v1", env: { XDG_DATA_HOME: xdg }, mount, listAuth: () => listed }),
      /owner-only/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("provider recognition probes agree between the case runner and the in-image verifier", () => {
  const probes = [
    "Credentials /home/node/.local/share/opencode/auth.json OpenCode Go api OpenAI api 2 credentials",
    "OpenAI api",
    "",
    "no credentials",
  ];
  for (const probe of probes) {
    assert.equal(CONTAINER_NORMALIZE_PROBE(probe), VERIFY_NORMALIZE_PROBE(probe), "normalization agrees");
    for (const id of ["openai", "opencode-go"]) {
      assert.equal(
        CONTAINER_PROVIDER_RECOGNIZED(probe, id),
        VERIFY_PROVIDER_RECOGNIZED(probe, id),
        `recognition of ${id} agrees`,
      );
    }
  }
  assert.equal(CONTAINER_PROVIDER_RECOGNIZED(probes[0], "opencode-go"), true, "display name maps to the provider id");
  assert.equal(CONTAINER_PROVIDER_RECOGNIZED(probes[0], "openai"), true);
  assert.equal(CONTAINER_PROVIDER_RECOGNIZED(probes[0], "anthropic"), false, "an absent provider is never inferred");
  assert.equal(CONTAINER_PROVIDER_RECOGNIZED("", "openai"), false, "empty output proves nothing");
  assert.equal(CONTAINER_PROVIDER_RECOGNIZED(probes[0], "openai/../x"), false, "non-ids are rejected");
  assert.equal(CONTAINER_NORMALIZE_PROBE("  OpenCode   Go  "), "opencode-go");

  // Host/container fixed-path tables agree.
  assert.equal(OPENCODE_AUTH_MOUNT, "/input/opencode-credential");
  assert.equal(RUNTIME.opencodeAuthDir, OPENCODE_AUTH_MOUNT, "host mount target matches the container mount");
  assert.equal(OPENCODE_AUTH_LEGACY, RUNTIME.opencodeAuthLegacy);
  assert.equal(OPENCODE_AUTH_IMPORT, RUNTIME.opencodeAuthImport);
  assert.equal(OPENCODE_AUTH_DATA, RUNTIME.opencodeAuthData);
});

test("the Claude path asserts the OpenCode credential mount is absent", () => {
  assert.equal(assertClaudeHasNoAuthMount(() => false), true);
  assert.equal(assertClaudeHasNoAuthMount(), true, "no credential mount exists on the host");
  assert.throws(
    () => assertClaudeHasNoAuthMount(() => true),
    (error) =>
      error instanceof CaseAssertionError &&
      error.stage === "auth" &&
      /Claude case must not receive the OpenCode credential mount/.test(error.message),
  );
});

test("the container refuses mounted credentials that carry any other provider", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "skill-router-provider-scope-"));
  try {
    const mount = path.join(root, "opencode-credential");
    mkdirSync(mount, { recursive: true, mode: 0o700 });
    chmodSync(mount, 0o700);
    const xdg = path.join(root, "xdg");
    mkdirSync(xdg, { recursive: true });
    const listed = { error: null, status: 0, output: "OpenAI api OpenCode Go api" };

    // A mis-scoped snapshot: both providers in both files.
    writeAuthFixture(mount, OPENCODE_AUTH_LEGACY, {
      openai: { type: "api", key: "sk-dummy-openai-000000000000000000000000" },
      "opencode-go": { type: "api", key: "sk-dummy-opencode-go-000000000000000000" },
    });
    writeAuthFixture(mount, OPENCODE_AUTH_IMPORT, [
      {
        id: "a".repeat(64),
        integrationID: "openai",
        label: "API key",
        active: true,
        value: { type: "key", key: "sk-dummy-openai-000000000000000000000000" },
      },
      {
        id: "b".repeat(64),
        integrationID: "opencode-go",
        label: "API key",
        active: true,
        value: { type: "key", key: "sk-dummy-opencode-go-000000000000000000" },
      },
    ]);

    assert.throws(
      () => setupOpenCodeAuth({ provider: "openai", harness: "opencode-v1", env: { XDG_DATA_HOME: xdg }, mount, listAuth: () => listed }),
      /must carry exactly the selected provider/,
      "v1 rejects an unfiltered legacy file",
    );
    assert.throws(
      () =>
        setupOpenCodeAuth({
          provider: "openai",
          harness: "opencode-v2",
          env: { XDG_DATA_HOME: xdg },
          mount,
          importAuth: () => ({ error: null, status: 0 }),
          listAuth: () => listed,
        }),
      /must carry exactly the selected provider/,
      "v2 rejects an unfiltered import file",
    );

    // Malformed shapes are structural failures too.
    writeAuthFixture(mount, OPENCODE_AUTH_LEGACY, "not-json");
    assert.throws(
      () => setupOpenCodeAuth({ provider: "openai", harness: "opencode-v1", env: { XDG_DATA_HOME: xdg }, mount, listAuth: () => listed }),
      /not valid JSON/,
    );
    writeAuthFixture(mount, OPENCODE_AUTH_IMPORT, { not: "an array" });
    assert.throws(
      () =>
        setupOpenCodeAuth({
          provider: "openai",
          harness: "opencode-v2",
          env: { XDG_DATA_HOME: xdg },
          mount,
          importAuth: () => ({ error: null, status: 0 }),
          listAuth: () => listed,
        }),
      /must be an array/,
    );

    // Correctly scoped files pass (regression guard for the happy path).
    writeAuthFixture(mount, OPENCODE_AUTH_LEGACY, {
      openai: { type: "api", key: "sk-dummy-openai-000000000000000000000000" },
    });
    writeAuthFixture(mount, OPENCODE_AUTH_IMPORT, [
      {
        id: "a".repeat(64),
        integrationID: "openai",
        label: "API key",
        active: true,
        value: { type: "key", key: "sk-dummy-openai-000000000000000000000000" },
      },
    ]);
    assert.deepEqual(
      setupOpenCodeAuth({
        provider: "openai",
        harness: "opencode-v2",
        env: { XDG_DATA_HOME: xdg },
        mount,
        importAuth: () => ({ error: null, status: 0 }),
        listAuth: () => ({ error: null, status: 0, output: "OpenAI api" }),
      }),
      { mode: "snapshot", provider: "openai", recognition: "listed" },
    );
    assert.deepEqual(
      setupOpenCodeAuth({ provider: "openai", harness: "opencode-v1", env: { XDG_DATA_HOME: xdg }, mount, listAuth: () => listed }),
      { mode: "snapshot", provider: "openai", recognition: "listed" },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------- OpenCode `patch` request-write support (live probe) ----------- */

const PATCH_TOKEN = "0123456789abcdef0123456789abcdef";
const PATCH_REQUEST_DIR = "/workspace/project/.skill-router-requests";
const PATCH_EXPECTED_PATH = `${PATCH_REQUEST_DIR}/${PATCH_TOKEN}.txt`;

/** Structured patch text in the pinned OpenCode dialect. */
function structuredPatch(token, content) {
  return ["*** Begin Patch", `*** Add File: ${PATCH_REQUEST_DIR}/${token}.txt`, `+${content}`, "*** End Patch"].join("\n");
}

function patchToolEvent({ token = PATCH_TOKEN, content = NONE_REQUEST, status = "completed", tool = REQUEST_PATCH_TOOL, patchText = null } = {}) {
  return {
    type: "tool_use",
    sessionID: "ses_inlinepatch",
    part: {
      type: "tool",
      tool,
      state: {
        status,
        input: { patchText: patchText ?? structuredPatch(token, content) },
        output: "patch applied",
      },
    },
  };
}

function routeToolEvent(token = PATCH_TOKEN, outcome = "none") {
  const payload = outcome === "none" ? { outcome: "none" } : { outcome: "select", skillId: "release" };
  return {
    type: "tool_use",
    sessionID: "ses_inlinepatch",
    part: {
      type: "tool",
      tool: "shell",
      state: {
        status: "completed",
        input: { command: `skill-router route --json --root . --request-token ${token}` },
        output: JSON.stringify(payload),
      },
    },
  };
}

function skillToolEvent(id) {
  return {
    type: "tool_use",
    sessionID: "ses_inlinepatch",
    part: { type: "tool", tool: "skill", state: { status: "completed", input: { id }, output: `${id} instructions loaded` } },
  };
}

function readToolEvent(filePath) {
  return {
    type: "tool_use",
    sessionID: "ses_inlinepatch",
    part: { type: "tool", tool: "read", state: { status: "completed", input: { filePath }, output: "observation only" } },
  };
}

function selectTailEvents() {
  return [
    skillToolEvent("release"),
    { type: "text", sessionID: "ses_inlinepatch", part: { type: "text", text: "Release notes are ready. RELEASE_SKILL_LOADED" } },
  ];
}

function patchBaseline({ scenario = "none", patch = {} } = {}) {
  const events = [
    skillToolEvent("skill-router"),
    patchToolEvent(patch),
    routeToolEvent(PATCH_TOKEN, scenario === "select" ? "select" : "none"),
  ];
  if (scenario === "select") events.push(...selectTailEvents());
  return events;
}

test("v2 patch events prove the request file before the route (none and select)", () => {
  const none = inspectOpenCodeRun(toStdout(fixture(FILES.v2NonePatch)), { scenario: "none", request: NONE_REQUEST });
  assert.deepEqual(none.chain, expectedCaseChain("opencode-v2", "none"), "patch fixture proves the none chain");
  assert.equal(none.outcome, "none");
  assert.equal(none.sessionCount, 1);

  const select = inspectOpenCodeRun(toStdout(fixture(FILES.v2SelectPatch)), { scenario: "select", request: SELECT_REQUEST });
  assert.deepEqual(select.chain, expectedCaseChain("opencode-v2", "select"), "patch fixture proves the select chain");
  assert.equal(select.outcome, "select");
  assert.equal(select.skillId, "release");

  // The traditional write path stays valid (regression guard).
  const writeNone = inspectOpenCodeRun(toStdout(fixture(FILES.v2None)), { scenario: "none", request: NONE_REQUEST });
  assert.deepEqual(writeNone.chain, expectedCaseChain("opencode-v2", "none"));
  const writeSelect = inspectOpenCodeRun(toStdout(fixture(FILES.v2Select)), { scenario: "select", request: SELECT_REQUEST });
  assert.deepEqual(writeSelect.chain, expectedCaseChain("opencode-v2", "select"));
});

test("patch proof is order-, token-, content-, and shape-exact", () => {
  // Patch after the route invocation is never accepted.
  expectCaseFailure(
    () => inspectOpenCodeRun(toStdout([skillToolEvent("skill-router"), routeToolEvent(), patchToolEvent()]), { scenario: "none", request: NONE_REQUEST }),
    /request file write occurred after the route invocation/,
  );

  // Wrong token: same directory, different file name.
  expectCaseFailure(
    () => inspectOpenCodeRun(toStdout(patchBaseline({ patch: { token: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } })), { scenario: "none", request: NONE_REQUEST }),
    /written request token did not match the route command token/,
  );

  // Wrong content.
  expectCaseFailure(
    () => inspectOpenCodeRun(toStdout(patchBaseline({ patch: { content: "orbital velocity" } })), { scenario: "none", request: NONE_REQUEST }),
    /request file content did not match the exact request bytes/,
  );

  // Traversal outside the requests directory.
  const traversal = structuredPatch(PATCH_TOKEN, NONE_REQUEST).replace(
    `${PATCH_REQUEST_DIR}/${PATCH_TOKEN}.txt`,
    `${PATCH_REQUEST_DIR}/../../evil.txt`,
  );
  expectCaseFailure(
    () => inspectOpenCodeRun(toStdout(patchBaseline({ patch: { patchText: traversal } })), { scenario: "none", request: NONE_REQUEST }),
    /invalid patch \(patch did not target the requests directory\)/,
  );

  // Multi-file patch.
  const multiFile = [
    "*** Begin Patch",
    `*** Add File: ${PATCH_REQUEST_DIR}/${PATCH_TOKEN}.txt`,
    `+${NONE_REQUEST}`,
    "*** Add File: /workspace/project/notes.txt",
    "+see me",
    "*** End Patch",
  ].join("\n");
  expectCaseFailure(
    () => inspectOpenCodeRun(toStdout(patchBaseline({ patch: { patchText: multiFile } })), { scenario: "none", request: NONE_REQUEST }),
    /invalid patch \(patch touched multiple files\)/,
  );

  // Delete-only patch.
  const deleteOnly = ["*** Begin Patch", `*** Delete File: ${PATCH_REQUEST_DIR}/${PATCH_TOKEN}.txt`, "*** End Patch"].join("\n");
  expectCaseFailure(
    () => inspectOpenCodeRun(toStdout(patchBaseline({ patch: { patchText: deleteOnly } })), { scenario: "none", request: NONE_REQUEST }),
    /invalid patch \(patch only deleted a file\)/,
  );

  // Rename (update + move) patch.
  const rename = [
    "*** Begin Patch",
    `*** Update File: ${PATCH_REQUEST_DIR}/${PATCH_TOKEN}.txt`,
    "*** Move to: /workspace/project/renamed.txt",
    "@@ -0,0 +1 @@",
    `+${NONE_REQUEST}`,
    "*** End Patch",
  ].join("\n");
  expectCaseFailure(
    () => inspectOpenCodeRun(toStdout(patchBaseline({ patch: { patchText: rename } })), { scenario: "none", request: NONE_REQUEST }),
    /invalid patch \(patch renamed the file\)/,
  );

  // Malformed patch that merely names the path.
  const malformed = `Add File: ${PATCH_REQUEST_DIR}/${PATCH_TOKEN}.txt\n+${NONE_REQUEST}`;
  expectCaseFailure(
    () => inspectOpenCodeRun(toStdout(patchBaseline({ patch: { patchText: malformed } })), { scenario: "none", request: NONE_REQUEST }),
    /invalid patch \(patch envelope was malformed\)/,
  );

  // Failed (non-completed) patch.
  expectCaseFailure(
    () => inspectOpenCodeRun(toStdout(patchBaseline({ patch: { status: "error" } })), { scenario: "none", request: NONE_REQUEST }),
    /request file write did not complete \(status error\)/,
  );

  // Duplicate writers: patch plus a write, and two patches.
  const patchThenWrite = patchBaseline();
  patchThenWrite.splice(2, 0, {
    type: "tool_use",
    sessionID: "ses_inlinepatch",
    part: { type: "tool", tool: "write", state: { status: "completed", input: { filePath: PATCH_EXPECTED_PATH, content: NONE_REQUEST }, output: "written" } },
  });
  expectCaseFailure(
    () => inspectOpenCodeRun(toStdout(patchThenWrite), { scenario: "none", request: NONE_REQUEST }),
    /request file had multiple writers \(patch, write\)/,
  );
  const twoPatches = patchBaseline();
  twoPatches.splice(3, 0, patchToolEvent({}));
  expectCaseFailure(
    () => inspectOpenCodeRun(toStdout(twoPatches), { scenario: "none", request: NONE_REQUEST }),
    /request file had multiple writers \(patch\)/,
  );

  // A read-only observation alone never proves the write.
  const readOnlyOnly = [skillToolEvent("skill-router"), readToolEvent(PATCH_EXPECTED_PATH), routeToolEvent()];
  expectCaseFailure(() => inspectOpenCodeRun(toStdout(readOnlyOnly), { scenario: "none", request: NONE_REQUEST }), /request file was never written/);

  // A read observation before the patch never blocks or satisfies the proof.
  const readThenPatch = [skillToolEvent("skill-router"), readToolEvent(PATCH_EXPECTED_PATH), patchToolEvent({}), routeToolEvent()];
  const observed = inspectOpenCodeRun(toStdout(readThenPatch), { scenario: "none", request: NONE_REQUEST });
  assert.deepEqual(observed.chain, expectedCaseChain("opencode-v2", "none"));

  // A patch whose structured path targets another file but whose text merely
  // mentions the request path is rejected, not accepted as proof.
  const mentionOnly = [
    "*** Begin Patch",
    "*** Add File: /workspace/project/notes.txt",
    `+see ${PATCH_REQUEST_DIR}/${PATCH_TOKEN}.txt`,
    "*** End Patch",
  ].join("\n");
  expectCaseFailure(
    () => inspectOpenCodeRun(toStdout(patchBaseline({ patch: { patchText: mentionOnly } })), { scenario: "none", request: NONE_REQUEST }),
    /invalid patch \(patch did not target the requests directory\)/,
  );
});

test("the pinned patch parser is structural and never echoes patch content", () => {
  const add = parseStructuredPatch(structuredPatch(PATCH_TOKEN, NONE_REQUEST));
  assert.equal(add.ok, true);
  assert.deepEqual(add.ops, [{ type: "add", path: PATCH_EXPECTED_PATH, content: NONE_REQUEST }]);

  const update = parseStructuredPatch(
    ["*** Begin Patch", `*** Update File: ${PATCH_EXPECTED_PATH}`, "@@ -0,0 +1 @@", `+${NONE_REQUEST}`, "*** End Patch"].join("\n"),
  );
  assert.equal(update.ok, true);
  assert.equal(update.ops[0].type, "update");
  assert.equal(update.ops[0].hunks.length, 1);
  assert.equal(update.ops[0].movePath, null);

  const moved = parseStructuredPatch(
    [
      "*** Begin Patch",
      `*** Update File: ${PATCH_EXPECTED_PATH}`,
      "*** End of File",
      "*** Move to: /workspace/project/renamed.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "*** End Patch",
    ].join("\n"),
  );
  assert.equal(moved.ok, true);
  assert.equal(moved.ops[0].movePath, "/workspace/project/renamed.txt");
  assert.equal(moved.ops[0].hunks[0].lines.length, 2);

  const deleted = parseStructuredPatch(
    ["*** Begin Patch", `*** Delete File: ${PATCH_EXPECTED_PATH}`, "*** End Patch"].join("\n"),
  );
  assert.equal(deleted.ok, true);
  assert.equal(deleted.ops[0].type, "delete");

  const rejections = [
    [`Add File: ${PATCH_EXPECTED_PATH}\n+${NONE_REQUEST}`, "patch envelope was malformed"],
    [`${structuredPatch(PATCH_TOKEN, NONE_REQUEST)} trailing`, "patch envelope was malformed"],
    [["*** Begin Patch", "*** End Patch"].join("\n"), "patch contained no file operations"],
    [["*** Begin Patch", `*** Delete File: ${PATCH_EXPECTED_PATH}`, "+body", "*** End Patch"].join("\n"), "Delete File section had body lines"],
    [["*** Begin Patch", `*** Add File: ${PATCH_EXPECTED_PATH}`, "plain line", "*** End Patch"].join("\n"), "invalid Add File line"],
    [["*** Begin Patch", `*** Update File: ${PATCH_EXPECTED_PATH}`, "+orphan", "@@ -0,0 +1 @@", `+${NONE_REQUEST}`, "*** End Patch"].join("\n"), "update section had content before its first hunk"],
    [["*** Begin Patch", `*** Update File: ${PATCH_EXPECTED_PATH}`, "*** End Patch"].join("\n"), "update section had no hunks"],
    [["*** Begin Patch", `*** Add File: `, `+${NONE_REQUEST}`, "*** End Patch"].join("\n"), "patch section had an empty path"],
    [null, "patch envelope was malformed"],
  ];
  for (const [text, reason] of rejections) {
    const parsed = parseStructuredPatch(text);
    assert.equal(parsed.ok, false, `${reason} must be rejected`);
    assert.equal(parsed.reason, reason);
    const serialized = JSON.stringify(parsed);
    assert.ok(!serialized.includes(NONE_REQUEST), "patch content never reaches a reason");
    assert.ok(!serialized.includes(PATCH_TOKEN), "patch paths/tokens never reach a reason");
  }
});

test("patch proof accepts only exact creation or provable update of the request file", () => {
  const request = NONE_REQUEST;

  const add = patchRequestProof({ patchText: structuredPatch(PATCH_TOKEN, request) }, PATCH_EXPECTED_PATH);
  assert.equal(add.ok, true, "exact Add File proves the write");
  assert.equal(add.path, PATCH_EXPECTED_PATH);
  assert.equal(add.content, request);

  const relative = patchRequestProof(
    {
      patchText: [
        "*** Begin Patch",
        `*** Add File: .skill-router-requests/${PATCH_TOKEN}.txt`,
        `+${request}`,
        "*** End Patch",
      ].join("\n"),
    },
    PATCH_EXPECTED_PATH,
  );
  assert.equal(relative.ok, true, "project-relative Add File resolves against the harness cwd");
  assert.equal(relative.path, PATCH_EXPECTED_PATH);

  const relativeTraversal = patchRequestProof(
    {
      patchText: [
        "*** Begin Patch",
        `*** Add File: ../project-copy/.skill-router-requests/${PATCH_TOKEN}.txt`,
        `+${request}`,
        "*** End Patch",
      ].join("\n"),
    },
    PATCH_EXPECTED_PATH,
  );
  assert.equal(relativeTraversal.ok, false, "relative traversal cannot escape into a sibling directory");
  assert.equal(relativeTraversal.reason, "patch did not target the requests directory");

  // The retired legacy spool is detected as a request target but is never a
  // valid proof: the patch fails structurally, and the reason stays structural.
  const legacyTarget = patchRequestProof(
    {
      patchText: [
        "*** Begin Patch",
        `*** Add File: /workspace/project/.skill-router/requests/${PATCH_TOKEN}.txt`,
        `+${request}`,
        "*** End Patch",
      ].join("\n"),
    },
    PATCH_EXPECTED_PATH,
  );
  assert.equal(legacyTarget.targetsRequest, true, "a legacy spool patch is still a candidate");
  assert.equal(legacyTarget.ok, false, "the retired spool never satisfies the proof");
  assert.equal(legacyTarget.reason, "patch targeted the retired requests directory");
  assert.ok(!JSON.stringify(legacyTarget).includes(PATCH_TOKEN), "no path/token leaks through the reason");

  // One trailing newline is tolerated: the pinned patch tool appends it when
  // writing an added file (a bare `+` line is how a patch expresses it).
  const trailing = patchRequestProof(
    { patchText: ["*** Begin Patch", `*** Add File: ${PATCH_EXPECTED_PATH}`, `+${request}`, "+", "*** End Patch"].join("\n") },
    PATCH_EXPECTED_PATH,
    request,
  );
  assert.equal(trailing.ok, true);
  assert.equal(trailing.content, `${request}\n`);

  // A provable zero-base update (empty file, all-added lines) is accepted.
  const update = patchRequestProof(
    { patchText: ["*** Begin Patch", `*** Update File: ${PATCH_EXPECTED_PATH}`, "@@ -0,0 +1 @@", `+${request}`, "*** End Patch"].join("\n") },
    PATCH_EXPECTED_PATH,
    request,
  );
  assert.equal(update.ok, true);

  // Updates that cannot be proven against an empty file are rejected.
  const withContext = patchRequestProof(
    { patchText: ["*** Begin Patch", `*** Update File: ${PATCH_EXPECTED_PATH}`, "@@ -1,1 +1,1 @@", `+${request}`, "*** End Patch"].join("\n") },
    PATCH_EXPECTED_PATH,
    request,
  );
  assert.equal(withContext.ok, false);
  assert.equal(withContext.reason, "patch update cannot be proven against an empty file");

  const withRemoval = patchRequestProof(
    { patchText: ["*** Begin Patch", `*** Update File: ${PATCH_EXPECTED_PATH}`, "@@ -0,0 +1 @@", `-${request}`, `+${request}`, "*** End Patch"].join("\n") },
    PATCH_EXPECTED_PATH,
    request,
  );
  assert.equal(withRemoval.ok, false);
  assert.equal(withRemoval.reason, "patch update included context or removal lines");

  // Structure is proven here; the *shared* content check in the inspector
  // rejects a payload that does not match the request (see the inspector test
  // above, which asserts the identical message for write and patch).
  const wrongContent = patchRequestProof({ patchText: structuredPatch(PATCH_TOKEN, "something else") }, PATCH_EXPECTED_PATH);
  assert.equal(wrongContent.ok, true, "structure alone is proven by the proof helper");
  assert.equal(wrongContent.content, "something else", "the payload is handed to the shared content check");

  // A patch in another directory is never a candidate at all.
  const foreign = patchRequestProof(
    { patchText: ["*** Begin Patch", "*** Add File: /workspace/project/notes.txt", `+${request}`, "*** End Patch"].join("\n") },
    PATCH_EXPECTED_PATH,
    request,
  );
  assert.equal(foreign.targetsRequest, false, "unrelated patches are not request candidates");

  // Same directory, other file: provable here, exact token enforced by the
  // inspector's path/token checks.
  const otherToken = patchRequestProof(
    { patchText: structuredPatch("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", request) },
    PATCH_EXPECTED_PATH,
    request,
  );
  assert.equal(otherToken.ok, true);
  assert.equal(otherToken.path, `${PATCH_REQUEST_DIR}/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.txt`);

  // Input variants: no structured text, and a declared conflicting path.
  assert.equal(patchRequestProof({}, PATCH_EXPECTED_PATH).reason, "patch input carried no structured patch text");
  const conflicting = patchRequestProof(
    { patchText: structuredPatch(PATCH_TOKEN, request), filePath: "/workspace/project/other.txt" },
    PATCH_EXPECTED_PATH,
    request,
  );
  assert.equal(conflicting.ok, false);
  assert.equal(conflicting.reason, "patch declared a conflicting path");
});

/* ------------ OpenCode route identification & output (v2 probe) -------------- */

function captureFailure(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof CaseAssertionError, `expected CaseAssertionError, got ${error?.name}`);
    return error;
  }
  assert.fail("expected the inspector to throw");
}

function routeEventOf(events) {
  const event = events.find((entry) => String(entry.part?.state?.input?.command ?? "").includes("skill-router route"));
  assert.ok(event, "fixture contains a route event");
  return event;
}

const DIAGNOSTIC_KEYS = [
  "content",
  "contentLength",
  "exit",
  "hasMeta",
  "hasToolCallId",
  "kind",
  "outputBytes",
  "outputKeyCount",
  "outputKeys",
  "outputKeysDropped",
  "outputType",
  "status",
  "tool",
].sort();

test("the wrapper PATH is prepended exactly once and never exposes the package bin", () => {
  const base = { PATH: "/usr/bin:/sbin", HOME: "/home/node" };
  const scoped = withWrapperPath(base);
  assert.equal(scoped.PATH, `${ROUTER_WRAPPER_DIR}:/usr/bin:/sbin`);
  assert.equal(scoped.HOME, "/home/node", "the rest of the environment is untouched");
  assert.equal(base.PATH, "/usr/bin:/sbin", "the incoming environment is never mutated");
  // The standard image PATH entry is deduplicated, never doubled.
  assert.equal(withWrapperPath({ PATH: `${ROUTER_WRAPPER_DIR}:/usr/bin` }).PATH, `${ROUTER_WRAPPER_DIR}:/usr/bin`);

  // Exactly once, even when already present (first, mid-list, repeated).
  assert.equal(withWrapperPath({ PATH: `${ROUTER_WRAPPER_DIR}:/usr/bin` }).PATH, `${ROUTER_WRAPPER_DIR}:/usr/bin`);
  assert.equal(
    withWrapperPath({ PATH: `/usr/bin:${ROUTER_WRAPPER_DIR}:/bin:${ROUTER_WRAPPER_DIR}` }).PATH,
    `${ROUTER_WRAPPER_DIR}:/usr/bin:/bin`,
  );

  // The non-executable package .bin is never exposed, even if a caller passes it.
  const packageBin = path.dirname(ROUTER_TARGET);
  assert.equal(withWrapperPath({ PATH: `${packageBin}:/usr/bin` }).PATH, `${ROUTER_WRAPPER_DIR}:/usr/bin`);
  const stripped = withWrapperPath({ PATH: `/usr/bin:${packageBin}:/bin` });
  assert.ok(!stripped.PATH.includes(packageBin), "package bin removed from PATH");
  assert.ok(!stripped.PATH.includes("node_modules/.bin"), "no package bin directory on PATH");
  assert.equal(stripped.PATH, `${ROUTER_WRAPPER_DIR}:/usr/bin:/bin`);

  // Empty/missing PATH still resolves the wrapper.
  assert.equal(withWrapperPath({}).PATH, ROUTER_WRAPPER_DIR);
  assert.equal(withWrapperPath({ PATH: "" }).PATH, ROUTER_WRAPPER_DIR);
});

test("the router executable preflight is status-only, PATH-scoped, and discards output", () => {
  const hostile = "SECRET-VALUE-0123456789 sk-ant-attack-0123456789";
  const calls = [];
  const childEnv = preflightRouterExecutable({
    env: { PATH: "/usr/bin:/opt/extra", HOME: "/home/node" },
    run: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stdout: `skill-router ${hostile}\n`, stderr: hostile, error: null };
    },
  });

  assert.equal(calls.length, 1, "exactly one preflight invocation");
  assert.equal(calls[0].command, "skill-router");
  assert.deepEqual(calls[0].args, ["--version"], "deterministic, non-mutating, status-only");
  assert.equal(calls[0].options.cwd, "/workspace/project", "runs with cwd PROJECT_DIR");
  assert.equal(
    calls[0].options.env.PATH,
    `${ROUTER_WRAPPER_DIR}:/usr/bin:/opt/extra`,
    "the model children's wrapper-PATH env is reused",
  );
  assert.ok(!calls[0].options.env.PATH.includes("node_modules/.bin"), "the package bin is never exposed");
  assert.equal(childEnv.PATH, `${ROUTER_WRAPPER_DIR}:/usr/bin:/opt/extra`, "returns the env model children receive");
  assert.ok(!JSON.stringify(childEnv).includes(hostile), "output is discarded, never returned");

  const failing = (result, pattern) => {
    assert.throws(
      () => preflightRouterExecutable({ env: { PATH: "/usr/bin" }, run: () => result }),
      (error) =>
        error instanceof CaseAssertionError &&
        error.stage === "env" &&
        pattern.test(error.message) &&
        !error.message.includes(hostile),
      `${pattern} without leaking output`,
    );
  };
  failing({ status: 1, stdout: hostile, stderr: hostile, error: null }, /exited with status 1/);
  failing({ status: undefined, stdout: hostile, stderr: hostile, error: null }, /did not report an exit status/);
  failing({ status: null, stdout: hostile, stderr: hostile, error: { code: "ENOENT" } }, /failed to start \(ENOENT\)/);
  assert.throws(
    () =>
      preflightRouterExecutable({
        env: { PATH: "/usr/bin" },
        run: () => {
          throw Object.assign(new Error(`boom ${hostile}`), { code: "EACCES" });
        },
      }),
    (error) => error instanceof CaseAssertionError && /failed to start \(EACCES\)/.test(error.message) && !error.message.includes(hostile),
  );
});

test("the managed route command parser accepts only the managed forms", () => {
  const token = "0123456789abcdef0123456789abcdef";
  const managed = `skill-router route --json --root . --request-token ${token}`;
  const parsed = parseManagedRouteCommand(managed);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.token, token);
  assert.equal(parsed.scope, "root");

  // Allowed: harmless whitespace, argument reordering, quoting, global scope.
  const allowed = [
    `  skill-router   route   --request-token ${token}   --root .   --json  `,
    `skill-router route --request-token ${token} --json --root .`,
    `skill-router route --json --root . --request-token "${token}"`,
    `skill-router route --request-token '${token}' --root . --json`,
    `skill-router route --json --global --request-token ${token}`,
    `skill-router route --request-token ${token} --global --json`,
  ];
  for (const command of allowed) {
    const result = parseManagedRouteCommand(command);
    assert.equal(result.ok, true, `accepted: ${command}`);
    assert.equal(result.token, token);
  }
  assert.equal(parseManagedRouteCommand(`skill-router route --json --global --request-token ${token}`).scope, "global");

  const rejected = [
    [`skill-router route --json --root . --request-token ${token} | cat`, "pipe"],
    [`skill-router route --json --root . --request-token ${token} > /tmp/out`, "redirect"],
    [`skill-router route --json --root . --request-token ${token} >> /tmp/out`, "append redirect"],
    [`skill-router route --json --root . --request-token ${token} && echo done`, "chaining"],
    [`skill-router route --json --root . --request-token ${token}; echo done`, "semicolon"],
    [`skill-router route --json --root . --request-token ${token} &`, "background"],
    [`skill-router route --json --root . --request-token $(cat /etc/passwd)`, "command substitution"],
    [`skill-router route --json --root . --request-token \`${token}\``, "backtick substitution"],
    [`skill-router route --json --root . --request-token \${TOKEN}`, "variable expansion"],
    [`node /opt/skill-router-install/node_modules/.bin/skill-router route --json --root . --request-token ${token}`, "absolute wrapper"],
    [`sudo skill-router route --json --root . --request-token ${token}`, "sudo wrapper"],
    [`env skill-router route --json --root . --request-token ${token}`, "env wrapper"],
    [`bash -c "skill-router route --json --root . --request-token ${token}"`, "shell wrapper"],
    [`echo "skill-router route --json --root . --request-token ${token}"`, "quoted echo"],
    [`grep "skill-router route" notes.md`, "grep of the phrase"],
    [`skill-router route --request-token ${token}`, "missing --json"],
    [`skill-router route --root . --request-token ${token}`, "missing --json (2)"],
    [`skill-router route --json --request-token ${token}`, "missing scope"],
    [`skill-router route --json --root .`, "missing token"],
    [`skill-router route --json --root . --request-token ${token} --root .`, "duplicate scope"],
    [`skill-router route --json --root . --request-token ${token} --request-token ${token}`, "duplicate token"],
    [`skill-router route --json --root . --request-token ${token} --json`, "duplicate --json"],
    [`skill-router route --json --root /workspace/project --request-token ${token}`, "root other than ."],
    [`skill-router route --json --root . --request-token ${token} --global`, "conflicting scope"],
    [`skill-router route --json --root . --request-token ${token} --print-logs`, "unknown option"],
    [`skill-router route --json --root . --request-token ${token} extra`, "extra positional"],
    [`skill-router route --json --root . --request-token ${token.slice(0, 31)}`, "short token"],
    [`skill-router route --json --root . --request-token ${token.toUpperCase()}`, "uppercase token"],
    [`skill-router.exe route --json --root . --request-token ${token}`, "binary name"],
    [`echo skill-router route --json --root . --request-token ${token}`, "echo wrapper"],
    ["", "empty command"],
    [null, "non-string command"],
  ];
  for (const [command, label] of rejected) {
    const result = parseManagedRouteCommand(command);
    assert.equal(result.ok, false, `must reject: ${label}`);
    assert.equal(typeof result.reason, "string", `${label} yields a fixed reason`);
    const serialized = JSON.stringify(result);
    if (typeof command === "string") {
      assert.ok(!serialized.includes(token), "the token never appears in a reason");
      assert.ok(!serialized.includes("/workspace"), "no path in a reason");
      assert.ok(!serialized.includes("--request-token"), "no command fragment in a reason");
    }
  }
});

test("route identification uses exactly one managed invocation", () => {
  // A false candidate before the exact route is skipped, not treated as the route.
  const withFalseCandidate = clone(fixture(FILES.v2None));
  const insertAt = withFalseCandidate.findIndex((entry) =>
    String(entry.part?.state?.input?.command ?? "").includes("skill-router route"),
  );
  assert.ok(insertAt > 0);
  withFalseCandidate.splice(insertAt, 0, {
    type: "tool_use",
    sessionID: "ses_fixtureopencodev2",
    part: {
      type: "tool",
      tool: "shell",
      state: {
        status: "completed",
        input: { command: "echo skill-router route --json --root . --request-token deadbeef" },
        output: "noop",
      },
    },
  });
  const skipped = inspectOpenCodeRun(toStdout(withFalseCandidate), { scenario: "none", request: NONE_REQUEST });
  assert.deepEqual(skipped.chain, expectedCaseChain("opencode-v2", "none"), "the exact route still proves the chain");

  // Duplicate managed invocations are rejected.
  const duplicate = clone(fixture(FILES.v2None));
  duplicate.push(clone(routeEventOf(duplicate)));
  expectCaseFailure(
    () => inspectOpenCodeRun(toStdout(duplicate), { scenario: "none", request: NONE_REQUEST }),
    /multiple managed route invocations detected/,
  );

  // A route-like command that is not the managed invocation is rejected.
  const wrapped = clone(fixture(FILES.v2None));
  routeEventOf(wrapped).part.state.input.command =
    `sudo skill-router route --json --root . --request-token ffeeddccbbaa99887766554433221100`;
  expectCaseFailure(
    () => inspectOpenCodeRun(toStdout(wrapped), { scenario: "none", request: NONE_REQUEST }),
    /route command was not the exact managed invocation/,
  );

  // So is a piped route command that still carries a valid token.
  const piped = clone(fixture(FILES.v2None));
  routeEventOf(piped).part.state.input.command =
    `skill-router route --json --root . --request-token ffeeddccbbaa99887766554433221100 | cat`;
  expectCaseFailure(
    () => inspectOpenCodeRun(toStdout(piped), { scenario: "none", request: NONE_REQUEST }),
    /route command was not the exact managed invocation/,
  );
  // Neither command nor token is ever echoed in the failure.
  const pipedError = captureFailure(() => inspectOpenCodeRun(toStdout(piped), { scenario: "none", request: NONE_REQUEST }));
  assert.equal(
    pipedError.message,
    "route command was not the exact managed invocation",
    "fixed structural message: no command, token, or fragment is echoed",
  );
});

test("pinned v2 shell metadata/content route outputs are accepted", () => {
  const metadata = inspectOpenCodeRun(toStdout(fixture(FILES.v2NoneMetadata)), { scenario: "none", request: NONE_REQUEST });
  assert.deepEqual(metadata.chain, expectedCaseChain("opencode-v2", "none"), "canonical output + nested metadata/exit");
  assert.equal(metadata.outcome, "none");

  const contentOnly = inspectOpenCodeRun(toStdout(fixture(FILES.v2NoneContent)), { scenario: "none", request: NONE_REQUEST });
  assert.deepEqual(contentOnly.chain, expectedCaseChain("opencode-v2", "none"), "documented content fallback");
  assert.equal(contentOnly.outcome, "none");
});

test("route exit must be exactly 0 whenever shell metadata exists", () => {
  const nonzero = clone(fixture(FILES.v2NoneMetadata));
  routeEventOf(nonzero).part.state.metadata.metadata.exit = 1;
  expectCaseFailure(
    () => inspectOpenCodeRun(toStdout(nonzero), { scenario: "none", request: NONE_REQUEST }),
    /route command reported a non-zero exit status/,
  );

  const stringExit = clone(fixture(FILES.v2NoneMetadata));
  routeEventOf(stringExit).part.state.metadata.metadata.exit = "0";
  expectCaseFailure(
    () => inspectOpenCodeRun(toStdout(stringExit), { scenario: "none", request: NONE_REQUEST }),
    /route command exit status was missing from its metadata/,
    "only an integer exit satisfies the requirement",
  );

  const missingExit = clone(fixture(FILES.v2NoneMetadata));
  delete routeEventOf(missingExit).part.state.metadata.metadata.exit;
  expectCaseFailure(
    () => inspectOpenCodeRun(toStdout(missingExit), { scenario: "none", request: NONE_REQUEST }),
    /route command exit status was missing from its metadata/,
  );

  // v1 compatibility: a legacy event with no nested metadata block at all is
  // not held to the exit rule (its fixture still passes above/below).
  const legacyEvent = routeEventOf(clone(fixture(FILES.v1None))).part.state;
  assert.equal("metadata" in legacyEvent, false, "legacy fixture carries no metadata block");
  const legacy = inspectOpenCodeRun(toStdout(fixture(FILES.v1None)), { scenario: "none", request: NONE_REQUEST });
  assert.deepEqual(legacy.chain, expectedCaseChain("opencode-v1", "none"));
});

test("route output extraction is documented, whole-value, and bounded", () => {
  const mutate = (fn) => {
    const events = clone(fixture(FILES.v2NoneMetadata));
    fn(routeEventOf(events).part.state);
    return events;
  };
  const reason = (events) =>
    captureFailure(() => inspectOpenCodeRun(toStdout(events), { scenario: "none", request: NONE_REQUEST }));

  // Absent: no canonical output and no documented content item.
  const absentState = (state) => {
    delete state.output;
    delete state.metadata.content;
  };
  const absent = reason(mutate(absentState));
  assert.equal(absent.stage, "parse");
  assert.match(absent.message, /produced no router JSON result/);
  assert.ok(Array.isArray(absent.diagnostic) && absent.diagnostic.length > 0, "parse failures carry a diagnostic");

  // Oversized (over 64 KiB) is rejected without parsing.
  const oversized = reason(mutate((state) => { state.output = "x".repeat(ROUTE_OUTPUT_MAX_BYTES + 1); }));
  assert.match(oversized.message, /exceeded the size limit/);

  // Ambiguous: two documented text items and no canonical output.
  const ambiguous = reason(
    mutate((state) => {
      delete state.output;
      state.metadata.content = [
        { type: "text", text: '{"outcome":"none"}' },
        { type: "text", text: '{"outcome":"select","skillId":"release"}' },
      ];
    }),
  );
  assert.match(ambiguous.message, /output was ambiguous/);

  // Not JSON: prose is never scanned for braces.
  const prose = reason(mutate((state) => { state.output = "The route returned {\"outcome\":\"none\"} ok"; }));
  assert.match(prose.message, /was not valid JSON/);

  // Whole-value object only: arrays are rejected.
  const arrayJson = reason(mutate((state) => { state.output = '[{"outcome":"none"}]'; }));
  assert.match(arrayJson.message, /not a JSON object/);

  // Conflicting representations fail closed.
  const conflicting = reason(
    mutate((state) => {
      state.output = '{"outcome":"none"}';
      state.metadata.content = [{ type: "text", text: '{"outcome":"select","skillId":"release"}' }];
    }),
  );
  assert.match(conflicting.message, /representations conflicted/);

  // `command` must be "route" when present (representations kept consistent so
  // the command check, not the conflict check, decides).
  const withCommand = (value) =>
    mutate((state) => {
      const text = JSON.stringify(value);
      state.output = text;
      state.metadata.content = [{ type: "text", text }];
    });
  assert.match(reason(withCommand({ outcome: "none", command: "route-v2" })).message, /unexpected command/);
  const rightCommand = inspectOpenCodeRun(toStdout(withCommand({ outcome: "none", command: "route" })), {
    scenario: "none",
    request: NONE_REQUEST,
  });
  assert.deepEqual(rightCommand.chain, expectedCaseChain("opencode-v2", "none"));
});

test("route JSON never carries a request field, the request bytes, or the token", () => {
  const routeToken = "ffeeddccbbaa99887766554433221100";
  const withRouteOutput = (value) => {
    const events = clone(fixture(FILES.v2NoneMetadata));
    const text = JSON.stringify(value);
    const route = routeEventOf(events);
    route.part.state.output = text;
    route.part.state.metadata.content = [{ type: "text", text }];
    return events;
  };

  const cases = [
    ["request field", { outcome: "none", request: NONE_REQUEST }, /route output carried a request field/],
    ["request bytes", { outcome: "none", note: NONE_REQUEST }, /route output carried the request bytes/],
    ["request token", { outcome: "none", echo: routeToken }, /route output carried the request token/],
  ];
  for (const [label, value, pattern] of cases) {
    const error = captureFailure(() =>
      inspectOpenCodeRun(toStdout(withRouteOutput(value)), { scenario: "none", request: NONE_REQUEST }),
    );
    assert.equal(error.stage, "parse", label);
    assert.match(error.message, pattern, label);
    assert.ok(Array.isArray(error.diagnostic) && error.diagnostic.length > 0, `${label}: schema-only diagnostic attached`);
    const reportText = JSON.stringify(
      buildFailureReport({ case: "opencode-v2-none", harness: "opencode-v2", scenario: "none" }, error),
    );
    assert.ok(!reportText.includes(NONE_REQUEST), `${label}: request bytes never reach a report`);
    assert.ok(!reportText.includes(routeToken), `${label}: token never reaches a report`);
  }

  // Claude's route tool_result is held to the same payload contract.
  const claudeRouteOutput = (value) => {
    const events = clone(fixture(FILES.claudeNone));
    const resultEvent = events.find((event) =>
      Array.isArray(event.message?.content) &&
      event.message.content.some((block) => block.type === "tool_result" && String(block.content ?? "").includes('"outcome"')),
    );
    assert.ok(resultEvent, "claude route tool_result fixture exists");
    resultEvent.message.content.find((block) => block.type === "tool_result").content = JSON.stringify(value);
    return events;
  };
  const claudeToken = "0123456789abcdef0123456789abcdef";
  const claudeCases = [
    ["request field", { outcome: "none", request: NONE_REQUEST }, /route output carried a request field/],
    ["request bytes", { outcome: "none", note: NONE_REQUEST }, /route output carried the request bytes/],
    ["request token", { outcome: "none", echo: claudeToken }, /route output carried the request token/],
  ];
  for (const [label, value, pattern] of claudeCases) {
    const error = captureFailure(() =>
      inspectClaudeRun(toStdout(claudeRouteOutput(value)), { scenario: "none", request: NONE_REQUEST }),
    );
    assert.match(error.message, pattern, `claude ${label}`);
    const reportText = JSON.stringify(
      buildFailureReport({ case: "claude-none", harness: "claude", scenario: "none" }, error),
    );
    assert.ok(!reportText.includes(NONE_REQUEST), `claude ${label}: request bytes never reach a report`);
    assert.ok(!reportText.includes(claudeToken), `claude ${label}: token never reach a report`);
  }

  // Unmodified fixtures on both harnesses keep the clean payload contract.
  assert.deepEqual(
    inspectOpenCodeRun(toStdout(fixture(FILES.v2NoneMetadata)), { scenario: "none", request: NONE_REQUEST }).chain,
    expectedCaseChain("opencode-v2", "none"),
  );
  assert.deepEqual(
    inspectClaudeRun(toStdout(fixture(FILES.claudeNone)), { scenario: "none", request: NONE_REQUEST }).chain,
    expectedCaseChain("claude", "none"),
  );
});

test("route-output parse failures carry a bounded schema-only diagnostic", () => {
  const hostile = [
    "sk-ant-secret-0123456789",
    "prepare and publish a release",
    "/workspace/project/.skill-router-requests/ffeeddccbbaa99887766554433221100.txt",
    "ffeeddccbbaa99887766554433221100",
  ];
  // Prose output plus several shell/route-ish events to exercise the cap.
  const events = clone(fixture(FILES.v2NoneMetadata));
  const failing = routeEventOf(events);
  failing.part.state.output = `route said ${hostile[1]} at ${hostile[2]} with ${hostile[0]}`;
  for (let index = 0; index < 6; index += 1) {
    events.push({
      type: "tool_use",
      sessionID: failing.sessionID,
      part: {
        type: "tool",
        tool: "shell",
        state: { status: "completed", input: { command: `echo ${hostile[3]}` }, output: `${hostile[0]} ${hostile[1]}` },
      },
    });
  }
  const error = captureFailure(() => inspectOpenCodeRun(toStdout(events), { scenario: "none", request: NONE_REQUEST }));
  assert.equal(error.stage, "parse");
  const diagnostic = error.diagnostic;
  assert.ok(Array.isArray(diagnostic), "diagnostic attached to the error");
  assert.ok(diagnostic.length > 0 && diagnostic.length <= ROUTE_DIAGNOSTIC_MAX_EVENTS, "at most 4 candidate events");

  const serialized = JSON.stringify(diagnostic);
  for (const needle of hostile) {
    assert.ok(!serialized.includes(needle), `diagnostic leaked: ${needle}`);
  }
  assert.ok(!serialized.includes("--request-token"), "no command text");
  assert.ok(!serialized.includes("echo"), "no command fragments");
  for (const record of diagnostic) {
    assert.deepEqual(Object.keys(record).sort(), DIAGNOSTIC_KEYS, "fixed key set only");
    assert.equal(typeof record.outputType, "string");
    assert.ok(record.outputType === "absent" || record.outputType === "string" || record.outputType === "object");
    assert.ok(record.exit === null || typeof record.exit === "number");
    assert.equal(typeof record.content, "object");
    assert.ok(record.content.count === 0 || Array.isArray(record.content.items));
    for (const item of record.content.items ?? []) {
      assert.deepEqual(Object.keys(item).sort(), ["dropped", "keys", "textLength", "type"], "fixed content-item keys");
      assert.equal(typeof item.textLength, "number", "length, never the text");
    }
    assert.ok(Array.isArray(record.outputKeys));
    for (const key of record.outputKeys) assert.match(key, /^[A-Za-z][A-Za-z0-9_]{0,31}$/);
  }

  // The failure report embeds the same bounded, value-free diagnostic.
  const report = buildFailureReport(
    { case: "opencode-v2-none", harness: "opencode-v2", scenario: "none" },
    error,
  );
  assert.equal(report.stage, "parse");
  const reportText = JSON.stringify(report);
  for (const needle of hostile) assert.ok(!reportText.includes(needle), `report leaked: ${needle}`);

  // The report sanitizer strips hostile or off-schema diagnostics entirely.
  const poisoned = new CaseAssertionError("parse", "boom");
  poisoned.diagnostic = [
    {
      kind: "shell",
      tool: "shell",
      status: "completed",
      exit: 0,
      hasMeta: true,
      hasToolCallId: false,
      outputType: "string",
      outputBytes: 12,
      outputKeys: [hostile[1]],
      outputKeysDropped: 0,
      outputKeyCount: 1,
      contentLength: 1,
      content: { count: 1, items: [{ type: "text", keys: [hostile[1]], dropped: 0, textLength: 12 }] },
      secretValue: hostile[0],
      nested: { apiKey: "sk-leak-0123456789", path: hostile[2] },
    },
  ];
  const poisonedReport = buildFailureReport({ case: "x", harness: "y", scenario: "none" }, poisoned);
  const poisonedText = JSON.stringify(poisonedReport.diagnostic);
  assert.ok(!poisonedText.includes(hostile[0]), "hostile value dropped");
  assert.ok(!poisonedText.includes(hostile[1]), "hostile key/name dropped");
  assert.ok(!poisonedText.includes(hostile[2]), "hostile path dropped");
  assert.ok(!poisonedText.includes("sk-leak"), "credential-shaped nested key dropped");
  assert.ok(!poisonedText.includes("apiKey"), "credential-shaped key name dropped");
});

test("normalized v2 events preserve shell structure without leaking values", () => {
  const events = fixture(FILES.v2NoneMetadata);
  const rawRoute = routeEventOf(events);
  const normalized = normalizeOpenCodeEvent(rawRoute);
  assert.equal(normalized.output, '{"outcome":"none"}', "canonical output preserved");
  assert.equal(normalized.exit, 0, "nested shell exit preserved");
  assert.equal(normalized.hasMeta, true, "nested metadata block preserved");
  assert.ok(Array.isArray(normalized.contentItems) && normalized.contentItems.length === 1, "ordered content array preserved");
  assert.equal(normalized.toolCallId, "call_route_001", "tool-call id preserved when safe-shaped");

  // Structural summaries never expose output, content, tokens, or ids.
  const summary = summarizeOpenCodeEvents([normalized]);
  const summaryText = JSON.stringify(summary);
  assert.ok(!summaryText.includes('{"outcome":"none"}'), "no raw output");
  assert.ok(!summaryText.includes("call_route_001"), "no tool-call id");
  assert.ok(!summaryText.includes("ffeeddccbbaa99887766554433221100"), "no token");
  assert.deepEqual(Object.keys(summary[0]).sort().filter((key) => !["kind", "tool", "status", "name"].includes(key)), []);

  // Legacy events without the nested block keep the previous shape.
  const legacy = normalizeOpenCodeEvent(routeEventOf(clone(fixture(FILES.v1None))));
  assert.equal(legacy.exit, null);
  assert.equal(legacy.hasMeta, false);
  assert.equal(legacy.contentItems, null);
  assert.equal(legacy.toolCallId, null);

  // Unsafe tool-call identifiers are dropped rather than stored.
  const unsafe = normalizeOpenCodeEvent({
    type: "tool_use",
    sessionID: "ses_hostile",
    part: { type: "tool", tool: "shell", state: { status: "completed", input: {}, output: "x" }, toolCallID: "$(evil)" },
  });
  assert.equal(unsafe.toolCallId, null);
});

/* --------------- Executable router wrapper (EACCES remediation) -------------- */

test("the immutable image-layer wrapper is verified fail-closed before any model process", () => {
  const source = readFileSync(path.join(repoRoot, "scripts", "router-wrapper.mjs"));
  const root = mkdtempSync(path.join(os.tmpdir(), "skill-router-verify-"));
  try {
    const target = path.join(root, "skill-router");
    writeFileSync(target, source, { mode: 0o555 });
    chmodSync(target, 0o555);

    // Pinned identity: host constants, staged source, and Dockerfile agree.
    assert.equal(ROUTER_WRAPPER_PATH, "/usr/local/bin/skill-router");
    assert.equal(ROUTER_WRAPPER_DIR, "/usr/local/bin");
    assert.equal(
      ROUTER_WRAPPER_SHA256,
      createHash("sha256").update(source).digest("hex"),
      "the pinned digest matches the staged wrapper source byte-for-byte",
    );

    // Image files are root-owned; the host copy is not, so ownership is injected.
    const imageStat = (overrides = {}) => ({
      ...statSync(target),
      uid: 0,
      isSymbolicLink: () => false,
      isFile: () => true,
      ...overrides,
    });
    assert.equal(
      verifyImmutableRouterWrapper({ target, io: { lstatSync: () => imageStat() } }),
      true,
      "the exact image-layer wrapper verifies",
    );

    const drift = [
      [
        { lstatSync: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); } },
        /is missing \(image layer\)/,
      ],
      [{ lstatSync: () => ({ isSymbolicLink: () => true, isFile: () => false, uid: 0, mode: 0o555 }) }, /regular non-symlink file/],
      [{ lstatSync: () => ({ isSymbolicLink: () => false, isFile: () => false, uid: 0, mode: 0o40755 }) }, /regular non-symlink file/],
      [{ lstatSync: () => imageStat({ uid: 1000 }) }, /not owned by the image root user/],
      [{ lstatSync: () => imageStat({ mode: 0o755 }) }, /more permissive than 0555/],
      [{ lstatSync: () => imageStat({ mode: 0o777 }) }, /more permissive than 0555/],
      [{ lstatSync: () => imageStat({ mode: 0o500 }) }, /not usable by the runtime user/],
      [{ lstatSync: () => imageStat({ mode: 0o444 }) }, /not usable by the runtime user/],
      [
        { lstatSync: () => imageStat(), readFileSync: () => Buffer.from("#!/usr/local/bin/node\n// tampered\n") },
        /does not match the pinned image source/,
      ],
      [
        {
          lstatSync: () => imageStat(),
          readFileSync: () => {
            throw Object.assign(new Error("eacces"), { code: "EACCES" });
          },
        },
        /could not be read/,
      ],
    ];
    for (const [io, pattern] of drift) {
      const error = captureFailure(() => verifyImmutableRouterWrapper({ target, io }));
      assert.ok(pattern.test(error.message), `expected ${pattern}, got "${error.message}"`);
      assert.ok(!error.message.includes(target), "no path in a fixed error");
      assert.ok(!error.message.includes(ROUTER_WRAPPER_SHA256), "no hash in a fixed error");
      assert.ok(!error.message.includes("tampered"), "no content in a fixed error");
    }

    // The fixed default path may never sit inside project/HOME/install storage.
    for (const forbidden of [PROJECT_DIR, "/home/node", INSTALL_PREFIX]) {
      assert.throws(
        () => verifyImmutableRouterWrapper({ target: `${forbidden}/skill-router` }),
        /must stay outside project\/HOME\/fixtures\/install storage/,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the immutable wrapper source is fixed, forward-only, and free of dynamic inputs", () => {
  const source = readFileSync(path.join(repoRoot, "scripts", "router-wrapper.mjs"), "utf8");
  // Executable code only: comments may legitimately mention paths/noexec.
  const code = source.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");

  assert.ok(source.startsWith("#!/usr/local/bin/node\n"), "shebang uses the known container Node binary");
  assert.equal((source.match(/require\(/g) ?? []).length, 1, "exactly one require");
  assert.ok(source.includes('require("node:child_process")'), "only the built-in child_process is imported");
  assert.ok(code.includes(ROUTER_TARGET), "the fixed package target is embedded");
  assert.ok(code.includes("process.execPath"), "it spawns the known container Node binary");
  assert.ok(code.includes("process.argv.slice(2)"), "argv is forwarded exactly");
  assert.ok(code.includes('stdio: "inherit"'), "stdio is inherited (no capture or pipe)");
  assert.ok(code.includes("result.status === null ? 1 : result.status"), "numeric exit status is forwarded");
  assert.ok(/result\.signal \? 1/.test(code), "signal collapses to a fixed nonzero");
  assert.ok(/process\.exit\(127\)/.test(code), "spawn failure is a fixed nonzero");
  for (const needle of [
    "${",
    "`",
    "/bin/sh",
    "execSync",
    "process.env",
    "process.cwd",
    "process.argv[1]",
    'require("fs")',
    "readFileSync",
    "child_process:",
  ]) {
    assert.ok(!code.includes(needle), `no ${needle} in the wrapper code`);
  }
  // Only fixed absolute paths appear in executable code.
  const paths = [...code.matchAll(/\/[A-Za-z0-9_./-]+/g)].map((match) => match[0]).filter((found) => found.length > 1);
  const allowed = new Set([ROUTER_TARGET, "/child_process", "/usr/local/bin/node"]);
  assert.ok(paths.length >= 2, "the fixed paths are present to scan");
  for (const found of paths) assert.ok(allowed.has(found), `unexpected embedded path: ${found}`);
  assert.equal(ROUTER_WRAPPER_SHA256, createHash("sha256").update(source).digest("hex"), "pinned digest matches the source");
});

test("Claude and OpenCode children share the wrapper PATH without introducing config roots", () => {
  const incoming = { PATH: "/usr/local/bin:/usr/bin", HOME: "/home/node" };
  const claude = claudeRunEnv(incoming);
  const opencode = openCodeRunEnv(incoming);

  assert.equal(claude.PATH, "/usr/local/bin:/usr/bin", "standard image PATH entry is deduplicated");
  assert.equal(opencode.PATH, claude.PATH, "identical wrapper PATH for both harnesses");
  for (const env of [claude, opencode]) {
    assert.ok(!env.PATH.includes("node_modules/.bin"), "the non-executable package bin is never exposed");
    assert.equal(env.PWD, "/workspace/project");
    assert.equal(env.HOME, "/home/node", "HOME stays container-local");
    assert.deepEqual(
      Object.keys(env).filter((key) => key.startsWith("XDG_")),
      [],
      "no XDG config roots are introduced by the child-env builders",
    );
    assert.ok(
      !("CLAUDE_CONFIG_DIR" in env) || env.CLAUDE_CONFIG_DIR === "/home/node/.claude",
      "the only config root is the container-local Claude one",
    );
  }
  assert.equal(claude.CLAUDE_CONFIG_DIR, "/home/node/.claude", "Claude config root is container-local");
  assert.ok(!("CLAUDE_CONFIG_DIR" in opencode), "OpenCode gets no config root");
  // The incoming PATH order is preserved after the wrapper dir, and a host PATH
  // containing the package bin is normalized to the wrapper only.
  assert.equal(openCodeRunEnv({ PATH: `/host/bin:${path.dirname(ROUTER_TARGET)}:/usr/bin` }).PATH, `${ROUTER_WRAPPER_DIR}:/host/bin:/usr/bin`);
});

test("the immutable wrapper is verified after install/bin validation and before router setup and model calls", () => {
  const source = readFileSync(path.join(repoRoot, "scripts", "container-run-case.mjs"), "utf8");
  const installBinCheck = source.indexOf("installed artifact did not provide a skill-router bin");
  const wrapperVerify = source.indexOf("verifyImmutableRouterWrapper();");
  const routerSetup = source.indexOf("assertRouterInstall({ harness: options.harness })");
  const preflight = source.indexOf("preflightRouterExecutable({ env: process.env })");
  const openCodeCall = source.indexOf("openCodeResult = runOpenCode(");
  const claudeCall = source.indexOf("stdout = runClaude(");

  for (const [label, index] of [
    ["package-bin existence check", installBinCheck],
    ["wrapper verification", wrapperVerify],
    ["router setup", routerSetup],
    ["status-only preflight", preflight],
    ["OpenCode launch", openCodeCall],
    ["Claude launch", claudeCall],
  ]) {
    assert.ok(index > 0, `${label} is present in the case flow`);
  }
  assert.ok(installBinCheck < wrapperVerify, "the wrapper is verified after install + package-bin validation");
  const productionResolve = source.indexOf("await ensureProductionInstallation();", installBinCheck);
  assert.ok(productionResolve > 0, "production constants are resolved from the installed artifact");
  assert.ok(
    installBinCheck < productionResolve && productionResolve < routerSetup,
    "production resolution happens after the verified install and before router setup",
  );
  assert.ok(wrapperVerify < routerSetup, "verification precedes router setup");
  assert.ok(wrapperVerify < preflight, "the wrapper is verified before the preflight that resolves it");
  assert.ok(preflight < openCodeCall && preflight < claudeCall, "preflight runs before every model process");
  assert.ok(wrapperVerify < openCodeCall && wrapperVerify < claudeCall, "verification precedes every model process");

  // Harness wiring: every initialization is explicit, Claude control never
  // initializes, and the generated plugin is the only routed plugin source.
  const harnessFlag = source.indexOf('"--harness", routerHarnessFlag(harness)');
  const flagValues = source.indexOf('harness === "claude" ? "claude" : "opencode"');
  const controlGuard = source.indexOf("if (options.harness !== \"claude\" || options.scenario !== \"control\")");
  const pluginDirArgv = source.indexOf("pluginDir: scenario === \"control\" ? null : PLUGIN_DIR");
  assert.ok(harnessFlag > 0, "init passes an explicit --harness value");
  assert.ok(flagValues > 0, "Claude cases pass claude and OpenCode cases pass opencode");
  assert.ok(controlGuard > 0 && controlGuard < routerSetup, "the uninitialized control guard precedes router setup");
  assert.ok(pluginDirArgv > 0, "only routed Claude runs receive --plugin-dir");
  assert.ok(
    source.indexOf("claudeRegistrationOptions()") > 0 && source.indexOf("CLAUDE_REGISTER_CONFIG_DIR") > 0,
    "Claude registration uses the scratch local-scope surfaces",
  );
});

test("the system ripgrep proof is target-isolated and fails closed on every drift", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "skill-router-rg-proof-"));
  try {
    // Target isolation: v2 and Claude require nothing from the image.
    assert.equal(VERIFY_SYSTEM_RIPGREP({ harness: "opencode-v2" }), null, "v2 needs no image ripgrep");
    assert.equal(VERIFY_SYSTEM_RIPGREP({ harness: "claude" }), null, "Claude needs no image ripgrep");
    assert.equal(VERIFY_SYSTEM_RIPGREP({ harness: null }), null, "no harness, no requirement");

    const binary = path.join(root, "rg");
    const owner = typeof process.getuid === "function" ? process.getuid() : 0;
    const env = { RIPGREP_PACKAGE: "ripgrep", RIPGREP_VERSION: "13.0.0-4+b2", RIPGREP_MAJOR: "13" };
    const listExecFile = (command) =>
      command === "dpkg-query" ? "13.0.0-4+b2\n" : "ripgrep 13.0.0\n-SIMD -AVX (compiled)\n";
    const okExec = () => ({ error: null, status: 0, stdout: "probe.txt\n", stderr: "" });

    const writeBinary = (mode) => {
      rmSync(binary, { force: true });
      writeFileSync(binary, "#!/bin/sh\n", { mode });
      chmodSync(binary, mode);
    };

    // The verifier is dependency-free inside the container and throws plain
    // errors, so failures are collected without the case-runner wrapper.
    const failWith = (overrides = {}) => {
      try {
        VERIFY_SYSTEM_RIPGREP({
          harness: "opencode-v1",
          env,
          binary,
          expectedOwner: owner,
          execFile: listExecFile,
          exec: okExec,
          tmpBase: root,
          ...overrides,
        });
      } catch (error) {
        return error;
      }
      throw new assert.AssertionError({ message: "expected the ripgrep proof to fail closed" });
    };

    // Happy path: one harmless file, enumerated through the pinned internal
    // path, with no downloaded copy left anywhere.
    writeBinary(0o755);
    assert.deepEqual(
      VERIFY_SYSTEM_RIPGREP({
        harness: "opencode-v1",
        env,
        binary,
        expectedOwner: owner,
        execFile: listExecFile,
        exec: okExec,
        tmpBase: root,
      }),
      { ripgrep: "system-ok", ripgrepVersion: "13.0.0" },
      "the exact system ripgrep verdict",
    );
    // A missing major bound is never unbounded: the verifier falls back to its
    // own bounded expectation instead of trusting whatever reports.
    const unboundedEnv = { RIPGREP_PACKAGE: "ripgrep", RIPGREP_VERSION: "13.0.0-4+b2" };
    assert.deepEqual(
      VERIFY_SYSTEM_RIPGREP({
        harness: "opencode-v1",
        env: unboundedEnv,
        binary,
        expectedOwner: owner,
        execFile: listExecFile,
        exec: okExec,
        tmpBase: root,
      }),
      { ripgrep: "system-ok", ripgrepVersion: "13.0.0" },
      "bounded-by-default when the image publishes no major",
    );

    const drift = [
      [{ binary: path.join(root, "absent-rg") }, /missing from the image/],
      [{ expectedOwner: owner + 1 }, /not image-root owned/],
      [{ env: { ...env, RIPGREP_MAJOR: "14" } }, /reports major 13, expected major 14/],
      [{ env: { ...env, RIPGREP_VERSION: "13.0.0-4+b3" } }, /package reports 13\.0\.0-4\+b2, expected pinned 13\.0\.0-4\+b3/],
      [
        {
          execFile: (command) => {
            if (command === "dpkg-query") throw new Error("dpkg failed");
            return "ripgrep 13.0.0\n";
          },
        },
        /package pin could not be read/,
      ],
      [{ execFile: () => { throw new Error("spawn failed"); } }, /could not be executed by the runtime user/],
      [{ execFile: () => "opencode 1.2.3\n" }, /unrecognized version/],
      [{ exec: () => ({ error: null, status: 7, stdout: "", stderr: "" }) }, /enumeration exited with status 7/],
      [{ exec: () => ({ error: null, status: 0, stdout: "other.txt\n", stderr: "" }) }, /did not list the probe file/],
      [
        {
          exec: (command, args, options) => {
            const cache = path.join(path.dirname(options.cwd), "home", ".cache", "bin");
            mkdirSync(cache, { recursive: true });
            writeFileSync(path.join(cache, "rg"), "#!/bin/sh\n", { mode: 0o755 });
            return { error: null, status: 0, stdout: "probe.txt\n", stderr: "" };
          },
        },
        /materialized in writable storage/,
      ],
    ];

    // Type/ownership/mode drift on the system binary itself.
    writeBinary(0o644);
    assert.match(failWith().message, /not executable by every user/);
    writeBinary(0o777);
    assert.match(failWith().message, /more permissive than 0755/);
    writeBinary(0o755);

    for (const [overrides, pattern] of drift) {
      const error = failWith(overrides);
      assert.ok(pattern.test(error.message), `expected ${pattern}, got "${error.message}"`);
      assert.ok(!error.message.includes(root), "no path in a fixed failure");
      assert.ok(!error.message.includes("/tmp"), "no directory listing in a fixed failure");
      assert.ok(!error.message.includes("harmless"), "no probe content in a fixed failure");
    }

    // Symlinked binary: never accepted as the immutable system copy.
    rmSync(binary, { force: true });
    writeBinary(0o755);
    const link = path.join(root, "rg-link");
    symlinkSync(binary, link);
    assert.match(failWith({ binary: link }).message, /regular non-symlink file/);

    // The probe directory always disappears, even on failure.
    const orphan = path.join(root, "skill-router-rg-probe-orphan");
    mkdirSync(orphan, { recursive: true });
    rmSync(orphan, { recursive: true, force: true });
    assert.equal(existsSync(orphan), false, "probe directories are removed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
