import { access, lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { normalizeConfig } from "./config.js";
import { DEFAULT_MAX_FILE_BYTES, readRegularFileNoFollow } from "./durable-fs.js";
import { discoverSources } from "./discovery.js";
import { inspectStateConfidentiality, inspectStateTree, planManagedState, stageManagedState } from "./managed-state.js";
import { parseFrontmatter, skillMetadata } from "./frontmatter.js";
import {
  classifyClaudeUninstallState,
  claudePaths,
  claudeRegistrationPlan,
  detachClaude,
  inspectGeneratedClaudeRemovalSource,
  observeClaudeUninstallState,
  planClaudePlugin,
  registerClaude,
  verifyClaudePluginFiles,
  verifyClaudeRegistration,
} from "./claude.js";
import {
  buildInstallation,
  claudeIdentity,
  directoryExists,
  installationProblems,
  readInstallation,
  readOwnedInstallationForRemoval,
  requestedHarnesses,
  selectHarnesses,
} from "./installation.js";
import { configuredSkillSources, planOpenCodeConfig, planOpenCodeRemoval, verifyOpenCodeRemoval } from "./opencode.js";
import { assertValidId, classifyId } from "./identifiers.js";
import { parseJsonBounded, readJsonText } from "./json-errors.js";
import { configPolicy, policyFingerprint } from "./policy.js";
import { assertRegistryIdentifiers, inspectRegistryIdentifiers } from "./registry.js";
import { routeRequest } from "./routing.js";
import { parseJsonc } from "./jsonc.js";
import {
  runControlledMutation,
  runControlledRead,
  runRecoveryOperation,
} from "./mutation-runner.js";
import {
  applyJournaledManagedTransaction,
  applyJournaledRemovalTransaction,
} from "./transaction.js";
import {
  assertConfigOutsideState,
  buildWorkspaceRegistry,
  expandPath,
  readRegistry,
  sourcePaths,
} from "./workspace.js";
import {
  assertLegacyRequestDirectoryEmpty,
  assertRequestSpoolEmpty,
  consumeRequest,
  inspectLegacyRequestDirectory,
  inspectRequestSpool,
  isRequestSpoolError,
  isValidRequestToken,
  legacyRequestRefusal,
  removeRequestSpoolIfEmpty,
  requestSpoolRefusal,
  setupRequestSpool,
} from "./requests.js";

/** Policy freshness is enforced for schema v2 configurations only. */
function policyFreshnessEnforced(config) {
  return (config.schemaVersion ?? 1) >= 2;
}

/**
 * Severity is the blocking policy: every error-level diagnostic emitted while
 * building the registry aborts regeneration, so a future unknown error code
 * cannot slip past an allowlist. Warning-only diagnostics stay non-blocking.
 */
export function blockingDiagnostics(registry) {
  return (registry?.diagnostics ?? []).filter((item) => item?.level === "error");
}

function serializeConfig(config) {
  return `${JSON.stringify(config, null, 2)}\n`;
}

function overlaps(left, right) {
  const relative = path.relative(left, right);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function verifyApplied(context, registry, harnesses, skillsDirectory, manualOpenCode) {
  const registryFile = path.join(context.stateDirectory, "registry.json");
  const installed = parseJsonBounded(await readJsonText(registryFile), { file: registryFile, kind: "registry JSON" });
  if (installed.fingerprint !== registry.fingerprint) throw new Error("registry verification failed");
  if (!harnesses.includes("opencode")) return;
  if (!manualOpenCode) {
    const openCode = parseJsonc(await readJsonText(context.openCodeConfig), context.openCodeConfig);
    if (!configuredSkillSources(openCode).includes(skillsDirectory)) throw new Error("OpenCode source verification failed");
  }
  await access(path.join(skillsDirectory, "skill-router", "SKILL.md"));
}

function claudeSummary(plan) {
  return {
    scope: plan.identity.claudeScope,
    plugin: plan.identity.plugin,
    marketplace: plan.identity.marketplace,
    marketplaceDirectory: plan.paths.marketplaceRoot,
    pluginDirectory: plan.paths.pluginRoot,
    fingerprint: plan.fingerprint,
    version: plan.version,
    skillCount: plan.skills.length,
  };
}

async function applyBuild(context, config, options = {}, control = null) {
  if (!control || !control.paths || !control.lease) {
    throw new TypeError("applyBuild requires the controlled mutation context ({paths, lease})");
  }
  // Config/state disjointness is a mutating-operation invariant: it must hold
  // for `init`, `add`, and `scan` alike, and for their dry-run preflight,
  // before staging, config writes, or any Claude mutation can be planned.
  await assertConfigOutsideState(context.configFile, context.stateDirectory);
  // Request-data preflight, read-only and side-effect free. An unsafe or
  // unattributed stable spool (foreign type/owner/marker, nonempty unmarked,
  // unbounded scan) refuses here, before any journal, config, state, or Claude
  // mutation — and before a dry-run reports its plan. A legacy request
  // directory that still holds entries refuses too, because the transaction
  // below replaces the very state those bytes live in; nothing is hashed,
  // copied, migrated, or deleted to prove that.
  await assertRequestSpoolSafe(context.requestDirectory);
  await assertLegacyRequestDirectoryEmpty(context.legacyRequestDirectory);
  const normalized = normalizeConfig(config);
  const currentContext = { ...context, config: normalized };
  // The last healthy registry decides which implicit default roots are still
  // expected, so an incomplete build aborts before staging, config writes, or
  // any Claude mutation.
  const installed = await readRegistry(context);
  const built = await buildWorkspaceRegistry(currentContext, normalized, { installed });
  for (const source of built.sources) {
    if (overlaps(source, context.stateDirectory) || overlaps(context.stateDirectory, source)) {
      throw new Error(`Skill source overlaps router-owned state: ${source}`);
    }
  }
  const blocking = blockingDiagnostics(built.registry);
  if (blocking.length) {
    throw new Error(blocking.map((item) => item.message).join("; "));
  }

  // Only `init` may request additional harnesses; `add` and `scan` regenerate
  // exactly what the installation metadata records. Legacy state without
  // metadata records OpenCode-only, and a new installation without an explicit
  // selection records OpenCode-only as well.
  const recorded = await readInstallation(context.stateDirectory);
  const harnesses = selectHarnesses({
    recorded: recorded?.harnesses,
    requested: requestedHarnesses(options.harnessRequest),
    stateExists: await directoryExists(context.stateDirectory),
  });
  const openCodeEnabled = harnesses.includes("opencode");

  const skillsDirectory = path.join(context.stateDirectory, "opencode-skills");
  // Shape resolution: an existing valid skills shape wins without spawning the
  // OpenCode CLI; only a normal (non-dry-run) execution may probe `opencode
  // --version`, and an uninferable shape yields a deferred plan — router-owned
  // generation still completes, but no OpenCode configuration is written.
  const openCode = openCodeEnabled
    ? await planOpenCodeConfig(context.openCodeConfig, skillsDirectory, undefined, { dryRun: options.dryRun === true })
    : { content: null, instruction: undefined, manual: false };

  let claudePlan = null;
  if (harnesses.includes("claude")) {
    claudePlan = await planClaudePlugin({
      registry: built.registry,
      identity: claudeIdentity({ global: context.global, stateDirectory: context.stateDirectory }),
      stateDirectory: context.stateDirectory,
      // Owner-private routing data is a planning input for the generated
      // Claude instructions and the fingerprint they produce. It never reaches
      // the operation result, the journal, or any diagnostic.
      requestDirectory: context.requestDirectory,
      recorded: recorded?.claude ?? null,
    });
  }
  const installation = buildInstallation({
    global: context.global,
    stateDirectory: context.stateDirectory,
    harnesses,
    claude: claudePlan ? { fingerprint: claudePlan.fingerprint, version: claudePlan.version } : null,
  });

  // Side-effect-free preflight of the managed OpenCode documents: the same
  // reads, destination checks, and rendering staging performs, so `--dry-run`
  // and the real run reject identical document-generation errors.
  const managedPlan = await planManagedState(context.stateDirectory, built.registry, {
    installation,
    global: context.global,
    requestDirectory: context.requestDirectory,
  });

  const plan = {
    root: context.root,
    configFile: context.configFile,
    registryFile: path.join(context.stateDirectory, "registry.json"),
    openCodeConfig: context.openCodeConfig,
    skillsDirectory,
    skillCount: built.registry.skills.length,
    fingerprint: built.registry.fingerprint,
    diagnostics: built.registry.diagnostics,
    manualAction: openCode.instruction,
    harnesses,
    ...(claudePlan ? { claude: claudeSummary(claudePlan) } : {}),
  };
  if (options.dryRun) return { ...plan, dryRun: true, registry: built.registry };

  // Read-only Claude preflight: it derives the journal's prior/desired
  // metadata from observation alone (never from assumptions) and refuses
  // unattributable registrations before anything is staged or journaled.
  const claude = claudePlan
    ? await claudeManagedPreflight({ context, claudePlan, installation: recorded, options })
    : null;

  const files = [
    {
      role: "router-config",
      path: context.configFile,
      content: serializeConfig(normalized),
      expectedBefore: await expectedConfigBytes(context.configFile),
    },
  ];
  if (openCode.content !== null) {
    files.push({
      role: "opencode-config",
      path: context.openCodeConfig,
      content: openCode.content,
      // Compare-and-swap against the exact bytes the OpenCode planner
      // observed: the recorded `original` bytes when the configuration
      // existed, or an explicit "must be absent" (`null`) when it did not.
      // A user edit anywhere between OpenCode planning and file-payload
      // planning therefore refuses before the journal, staging, config
      // writes, or any Claude mutation can begin.
      expectedBefore: openCode.original ?? null,
    });
  }

  // The stable spool is an allowed retry-safe pre-transaction side effect, so
  // it is created (or its mode normalized) only after every read-only
  // build/Claude preflight has passed and immediately before the journaled
  // transaction applies. That way an unrelated discovery or Claude-preflight
  // failure never leaves an empty spool behind. Missing parents — the global
  // `<home>/.local/share` chain on a fresh account — are created safely.
  await setupRequestSpool(context.requestDirectory, { createParents: true });

  await applyJournaledManagedTransaction({
    paths: control.paths,
    lease: control.lease,
    command: options.command ?? "init",
    root: context.root,
    scope: context.global ? "global" : "project",
    stateDirectory: context.stateDirectory,
    files,
    // Phase 7 blocker 1: the legacy-request bracket runs inside the
    // transaction, around the prior-state snapshot, so a request written after
    // this command's early preflight can never be journaled or swept away.
    priorStateGuard: legacyRequestsGuard(context),
    buildStage: (exactPath) =>
      stageManagedState(context.stateDirectory, built.registry, {
        global: context.global,
        installation,
        claudePlan,
        plan: managedPlan,
        requestDirectory: context.requestDirectory,
        stageDirectory: exactPath,
      }),
    verify: () => verifyApplied(context, built.registry, harnesses, skillsDirectory, openCode.manual),
    ...(claude ? { claude } : {}),
    claudeExec: options.claudeExec,
    claudeEnv: options.claudeEnv,
    cwd: context.root,
  });
  return { ...plan, dryRun: false, registry: built.registry };
}

/**
 * Read-only gate shared by `init`/`add`/`scan` (dry runs included): the stable
 * spool must be absent, adoptable, already ready, or a repairable mode drift.
 * A foreign type/owner/marker, a nonempty unmarked directory, or an unbounded
 * scan refuses with the fixed request-spool error set, so an unsafe spool can
 * never sit beside a journal, config, state, or Claude mutation. This never
 * creates, chmods, or writes anything — the real run's `setupRequestSpool`
 * performs the repair after every other preflight has passed.
 */
async function assertRequestSpoolSafe(directory) {
  const inspection = await inspectRequestSpool(directory);
  const refusal = requestSpoolRefusal(inspection);
  if (refusal) throw refusal;
  return inspection;
}

/**
 * Phase 7 blocker 1 — the transaction's legacy-request bracket.
 *
 * An old harness can write `<state>/requests/<token>.txt` (or a claim, or any
 * unknown name) *after* this command's own early preflight and while the
 * transaction is planning. Without a second look, that entry would be hashed
 * into the journaled prior-state digest and then deleted with the backup. This
 * guard runs inside the transaction, immediately before and immediately after
 * the prior-state snapshot, and the snapshot itself never descends into the
 * legacy subtree, so no request file is ever read or hashed.
 *
 * Every refusal is the fixed, generic request error set: no request body,
 * token, entry name, count, path, or digest is echoed.
 */
function legacyRequestsGuard(context) {
  return {
    assertSafe: async () => {
      const refusal = legacyRequestRefusal(await inspectLegacyRequestDirectory(context.legacyRequestDirectory));
      if (refusal) throw refusal;
    },
    inspectState: async (directory) => {
      const info = await inspectStateTree(directory, { skipLegacyRequests: true });
      if (info.status === "owned" && (info.legacyRequests === "present" || info.legacyRequests === "unsafe")) {
        throw legacyRequestRefusal({ status: info.legacyRequests === "present" ? "present" : "unsafe" });
      }
      return info;
    },
  };
}

/**
 * Exact prior bytes of the router configuration for the journaled plan's
 * compare-and-swap: a missing file records "expected absent", and a
 * non-regular configuration refuses with the established wording before any
 * journal or payload exists.
 */
async function expectedConfigBytes(file) {
  try {
    return await readRegularFileNoFollow(file, { maxBytes: DEFAULT_MAX_FILE_BYTES, allowMissing: true });
  } catch (error) {
    if (["ELOOP", "EFTYPE", "EBUSY", "EACCES", "EPERM"].includes(error?.code)) {
      throw new Error(`Refusing to replace non-regular file: ${file}`);
    }
    throw error;
  }
}

/**
 * Read-only Claude preflight for a journaled managed transaction. It observes
 * the registration exactly as uninstall does and records the journal's
 * `prior`/`desired` from the classification: healthy or absent are recorded
 * (with drift auto-corrected by registration), while drift that cannot be
 * attributed safely refuses before staging — a wrong-path declaration keeps
 * the Phase 1 wording verbatim so existing guidance still matches.
 */
async function claudeManagedPreflight({ context, claudePlan, installation, options }) {
  const registration = claudePlan.registration;
  const observed = await observeClaudeUninstallState({
    plan: registration,
    exec: options.claudeExec,
    cwd: context.root,
    env: options.claudeEnv,
  });
  const evaluated = classifyClaudeUninstallState(observed, registration, installation);
  if (evaluated.classification === "drift") {
    const declaration = observed.declaration;
    if (
      declaration &&
      typeof declaration.path === "string" &&
      declaration.path !== "" &&
      path.resolve(declaration.path) !== path.resolve(registration.marketplaceRoot)
    ) {
      throw new Error(
        `Claude marketplace ${registration.identity.marketplace} is already declared at ${registration.scope} scope with a different path; refusing to replace it`,
      );
    }
    throw new Error(
      `Claude registration cannot be updated safely: ${boundedDriftReasons(evaluated.reasons)}. ` +
        "Repair it with skill-router init, then retry.",
    );
  }
  return {
    metadata: {
      reference: registration.reference,
      scope: registration.scope,
      marketplace: registration.identity.marketplace,
      marketplaceRoot: registration.marketplaceRoot,
      version: claudePlan.version,
      prior: evaluated.classification === "healthy" ? "healthy" : "absent",
      desired: "healthy",
    },
    apply: ({ observer }) =>
      registerClaude({
        plan: registration,
        exec: options.claudeExec,
        actions: [],
        cwd: context.root,
        env: options.claudeEnv,
        observer,
      }),
  };
}

/** `init` under the controlled mutation runner: lock, recover, anchor, context. */
export async function initOperation(options = {}) {
  return runControlledMutation({
    command: "init",
    options,
    operation: ({ context, paths, lease }) =>
      initWithContext(context, { ...options, command: "init" }, { paths, lease }),
  });
}

async function initWithContext(context, options, control) {
  requestedHarnesses(options.harness);
  const result = await applyBuild(context, context.config, { ...options, harnessRequest: options.harness }, control);
  return { command: "init", scope: context.global ? "global" : "project", ...result };
}

function registryDiff(before, after) {
  // The prior registry is untrusted material: a malformed legacy document
  // (non-array `skills`) is inert inventory, and only identifiers that still
  // pass the public grammar may be named in a diff. A poisoned installed ID
  // disappears from the diff without ever being echoed into the operation
  // result, the JSON document, or a human line.
  const priorSkills = Array.isArray(before?.skills) ? before.skills : [];
  const oldSkills = new Map(
    priorSkills
      .filter((skill) => skill && classifyId(skill.id) === null)
      .map((skill) => [skill.id, skill]),
  );
  const newSkills = new Map(after.skills.map((skill) => [skill.id, skill]));
  return {
    added: [...newSkills.keys()].filter((id) => !oldSkills.has(id)),
    removed: [...oldSkills.keys()].filter((id) => !newSkills.has(id)),
    changed: [...newSkills.keys()].filter(
      (id) => oldSkills.has(id) && JSON.stringify(oldSkills.get(id)) !== JSON.stringify(newSkills.get(id)),
    ),
  };
}

export async function scanOperation(options = {}) {
  return runControlledMutation({
    command: "scan",
    options,
    operation: async ({ context, paths, lease }) => {
      const before = await readRegistry(context);
      // No exception for missing sources: scan uses the same completeness gate
      // as init/add (and the same gate protects its dry-run plan).
      const result = await applyBuild(context, context.config, { ...options, command: "scan" }, { paths, lease });
      return {
        command: "scan",
        diff: registryDiff(before, result.registry),
        policyChanged:
          policyFreshnessEnforced(context.config) &&
          Boolean(before) &&
          before.policyHash !== result.registry.policyHash,
        ...result,
      };
    },
  });
}

/**
 * Routing may never silently use stale configuration policy. This applies to
 * schema v2 only: schema v1 reads aliases, enablement, descriptions, and
 * thresholds straight from the configuration and never requires a scan, even
 * when an older generated registry carries a policy hash. Schema v2 registries
 * must always carry a matching policy hash.
 */
export function assertFreshPolicy(registry, config) {
  if (!policyFreshnessEnforced(config)) return;
  const expected = policyFingerprint(configPolicy(config));
  if (registry.policyHash === undefined) {
    throw new Error("Registry predates schemaVersion 2 policy; run skill-router scan first");
  }
  if (registry.policyHash !== expected) {
    throw new Error("Registry policy is stale; run skill-router scan first");
  }
}

/**
 * Schema v1 has no policy fingerprint by design, but its live-read semantics
 * leave one stale state routing must never use silently: an installed registry
 * that recorded `enabled: false` while the current configuration enables the
 * skill again — explicitly, or by the enabled-by-default rule. The live
 * configuration's `enabled: false` keeps its immediate routing veto and is
 * never staleness, and a missing or unusable registry keeps its own earlier
 * refusal, so a live `true` can never bypass a missing harness artifact.
 * Schema v2 already folds `enabled` into its policy hash, so it is excluded
 * here instead of gaining a second fingerprint.
 */
export function staleEnablementIds(registry, config) {
  if ((config?.schemaVersion ?? 1) >= 2) return [];
  const skills = Array.isArray(registry?.skills) ? registry.skills : [];
  const stale = [];
  for (const skill of skills) {
    if (!skill || skill.enabled !== false || typeof skill.id !== "string") continue;
    if (config.skills?.[skill.id]?.enabled === false) continue;
    stale.push(skill.id);
  }
  return stale;
}

export function assertFreshEnablement(registry, config) {
  if (staleEnablementIds(registry, config).length) {
    throw new Error("Registry skill enablement is stale; run skill-router scan first");
  }
}

/**
 * Every routing precondition, in the only safe order: the registry must exist,
 * its public identifiers must be portable, and its policy and enablement must
 * be fresh *before* a request is claimed or a spool is created, so a missing,
 * poisoned, or stale installation can never consume a request or leave spool
 * state behind. The identifier gate runs first: an installed registry is
 * untrusted material, and every later consumer (scoring, workflow steps,
 * handoffs, managed paths) treats its IDs as safe only after this refusal
 * point.
 */
async function loadRoutingRegistry(context) {
  const registry = await readRegistry(context);
  if (!registry) throw new Error("Skill Router is not initialized; run skill-router init first");
  assertRegistryIdentifiers(registry);
  assertFreshPolicy(registry, context.config);
  assertFreshEnablement(registry, context.config);
  return registry;
}

/**
 * Routing is read-only but never races a mutation: it holds the same lease for
 * the whole read, and a pending or malformed journal refuses before any route
 * is produced (see `runControlledRead`).
 */
export async function routeOperation(request, options = {}) {
  return runControlledRead({
    command: "route",
    options,
    operation: ({ context }) => routeWithContext(context, request),
  });
}

/**
 * Request-output privacy: the original request bytes are the untrusted input,
 * so they are consumed inside the read lease and dropped before any result
 * exists. Routing metadata (`command`, `outcome`, `skillId`/`workflowId`,
 * `confidence`, `candidates`, `reason`, `handoffs`, ...) is derived from the
 * request and is returned unchanged; only the request itself is omitted, so no
 * `--json` document, human line, or later error can echo request bytes.
 */
async function routeWithContext(context, request) {
  const registry = await loadRoutingRegistry(context);
  return { command: "route", ...routeRequest(request, registry, context.config) };
}

/**
 * Token routing over the stable owner-private spool.
 *
 * The registry and policy are proven first, then the stable spool is
 * idempotently established under the same held lease (an allowed retry-safe
 * side effect that migrates old installations), and only then is the request
 * claimed through `consumeRequest`. The routing callback deliberately does
 * nothing but score the already-validated request, so the registry is loaded
 * once. A pending journal, live lock, invalid context, missing registry,
 * invalid installed identifiers, or stale policy all refuse before the spool
 * is set up or the request touched; the request bytes, token, path, and digest
 * never reach a result, an error message or property, or the stack.
 */
export async function routeFileOperation(requestToken, options = {}) {
  if (!isValidRequestToken(requestToken)) {
    throw new Error("--request-token must be exactly 32 lowercase hexadecimal characters");
  }
  return runControlledRead({
    command: "route",
    options,
    operation: async ({ context }) => {
      const registry = await loadRoutingRegistry(context);
      await setupRequestSpool(context.requestDirectory, { createParents: true });
      return consumeRequest({
        directory: context.requestDirectory,
        token: requestToken,
        legacyDirectory: context.legacyRequestDirectory,
        route: (request) => ({ command: "route", ...routeRequest(request, registry, context.config) }),
      });
    },
  });
}

async function pathExists(value) {
  try {
    return await lstat(value);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Stat of an untrusted `add` target. Node embeds the raw value in its own
 * stat errors (NUL bytes, overlong names, symlink cycles), so anything that
 * is not a clean ENOENT is reported as "no selectable path": the fixed
 * refusal below then applies and the target is never echoed.
 */
async function targetPathStat(value) {
  try {
    return await lstat(value);
  } catch {
    return null;
  }
}

async function persistedSource(target, stat) {
  if (stat.isFile()) return target;
  if (!stat.isDirectory()) throw new Error(`Unsupported skill source: ${target}`);
  const skillFile = path.join(target, "SKILL.md");
  return (await pathExists(skillFile))?.isFile() ? skillFile : target;
}

/**
 * Blocking discovery diagnostics must surface as themselves during `add`
 * selection: an invalid/reserved candidate or a malformed target source is
 * the real failure, and it may never collapse into `No skill found`.
 */
function assertNoBlockingDiscovery(discovery) {
  const blocking = blockingDiagnostics({ diagnostics: discovery.diagnostics });
  if (blocking.length) throw new Error(blocking.map((item) => item.message).join("; "));
}

/**
 * `add` runs entirely inside the mutation lease: source discovery, skill
 * selection, and the regeneration all happen while the lock is held, so a
 * concurrent mutation can neither race the discovery nor the build.
 *
 * Selection order is deterministic: with `--source` the positional target is
 * an ID selector validated immediately (before any discovery, spool, journal,
 * config, or harness activity); without it, an exact currently discovered
 * valid ID wins over a same-named existing local path, and only then does a
 * missing-but-valid ID earn the `No skill found` error. A target that is
 * neither an existing path nor a valid public ID is a fixed, bounded refusal
 * that never echoes the target.
 */
export async function addOperation(target, options = {}) {
  if (!target) throw new Error("add requires a skill ID or local path");
  return runControlledMutation({
    command: "add",
    options,
    operation: async ({ context, paths, lease }) => {
      const config = structuredClone(context.config);
      let requestedSource;

      if (options.source) {
        // The selector is an ID, so the shared contract applies before source
        // discovery, spool, journal, config, or harness work can begin.
        assertValidId(target, "add target");
        requestedSource = expandPath(options.source, context.root, context.home);
        if (!(await pathExists(requestedSource))) throw new Error(`Skill source does not exist: ${requestedSource}`);
        if (!config.sources.includes(requestedSource)) config.sources.push(requestedSource);
      }

      const initialSources = await sourcePaths({ ...context, config }, config);
      const initialDiscovery = await discoverSources(initialSources);
      assertNoBlockingDiscovery(initialDiscovery);

      // An exact discovered valid ID wins over a same-named local path;
      // discovery only ever emits portable IDs, so `id === target` is already
      // a public-grammar match.
      const discoveredID = initialDiscovery.skills.some((skill) => skill.id === target);
      const possiblePath = expandPath(target, context.root, context.home);
      const targetStat = discoveredID ? null : await targetPathStat(possiblePath);
      if (!discoveredID && !targetStat) {
        if (classifyId(target) !== null) {
          throw new Error("Add target is neither an existing local path nor a valid public skill ID");
        }
        throw new Error(`No skill found for: ${target}`);
      }
      if (targetStat) {
        requestedSource = await persistedSource(possiblePath, targetStat);
        if (!config.sources.includes(requestedSource)) config.sources.push(requestedSource);
      }

      const sources = await sourcePaths({ ...context, config }, config);
      const discovery = await discoverSources(sources);
      assertNoBlockingDiscovery(discovery);
      let selected;
      if (targetStat) {
        const exactSource = path.resolve(requestedSource);
        selected = discovery.skills.filter(
          (skill) => skill.source === exactSource || skill.path === exactSource || skill.path.startsWith(`${exactSource}${path.sep}`),
        );
      } else {
        selected = discovery.skills.filter((skill) => skill.id === target);
        if (requestedSource) {
          const fromRequested = selected.filter(
            (skill) => skill.source === requestedSource || skill.path.startsWith(`${requestedSource}${path.sep}`),
          );
          if (fromRequested.length) selected = fromRequested;
        }
      }
      selected = [...new Map(selected.map((skill) => [skill.path, skill])).values()];
      if (selected.length === 0) throw new Error(`No skill found for: ${target}`);
      if (selected.length > 1 && targetStat && !options.yes && !options.dryRun) {
        throw new Error(`Source contains ${selected.length} skills; rerun with --yes to add all`);
      }
      if (selected.length > 1 && !targetStat && !options.replace) {
        const highest = Math.max(...selected.map((skill) => skill.sourceIndex));
        selected = selected.filter((skill) => skill.sourceIndex === highest);
        if (selected.length > 1) throw new Error(`Skill ID ${target} is ambiguous; use --source and --replace`);
      }
      if (selected.length > 1 && !targetStat && options.replace) {
        throw new Error(`Skill ID ${target} has multiple definitions; add the exact skill file or directory with --replace`);
      }
      if ((options.aliases?.length || options.description) && selected.length !== 1) {
        throw new Error("--alias and --description require exactly one added skill");
      }

      for (const skill of selected) {
        const prior = Object.hasOwn(config.skills, skill.id) ? config.skills[skill.id] : {};
        const settings = { ...prior, enabled: !options.noEnable };
        if (options.description) settings.description = options.description;
        if (options.replace) settings.source = skill.path;
        Object.defineProperty(config.skills, skill.id, {
          value: settings,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      for (const alias of options.aliases ?? []) {
        Object.defineProperty(config.aliases, alias, {
          value: selected[0].id,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }

      const result = await applyBuild(context, config, { ...options, command: "add" }, { paths, lease });
      return { command: "add", added: selected.map((skill) => skill.id), ...result };
    },
  });
}

/**
 * `check` is read-only but must still report the control plane: a pending
 * transaction or a malformed journal returns exactly one bounded diagnostic
 * (`recovery-required` / `invalid-journal`) and skips every source and Claude
 * probe, and a busy lock returns `mutation-locked` instead of failing the
 * command with an exception.
 */
export async function checkOperation(options = {}) {
  return runControlledRead({
    command: "check",
    options,
    onPending: ({ requirement, controlContext }) => unhealthyControlResult("recovery-required", requirement, controlContext),
    onInvalid: ({ requirement, controlContext }) => unhealthyControlResult("invalid-journal", requirement, controlContext),
    onLockTimeout: ({ error, controlContext }) =>
      unhealthyControlResult("mutation-locked", { message: error.message }, controlContext),
    operation: ({ context }) => checkWithContext(context, options),
  });
}

function unhealthyControlResult(code, detail, controlContext) {
  const message =
    code === "recovery-required"
      ? `A pending ${detail?.kind ?? "transaction"} transaction must be recovered before this command can run; run skill-router recover`
      : code === "invalid-journal"
        ? `The transaction journal cannot be trusted: ${detail?.message ?? "it is malformed"}`
        : `The mutation lock is busy: ${detail?.message ?? "it is held by another process"}`;
  return {
    command: "check",
    root: controlContext.root,
    healthy: false,
    harnesses: [],
    diagnostics: [{ level: "error", code, message: String(message).slice(0, 400) }],
  };
}

/**
 * The confidentiality inspector's fixed issue vocabulary. Only these codes —
 * never a filesystem path, name, token, uid, mode string, byte count, or
 * underlying cause — may reach a diagnostic, because a relative sample path
 * can itself contain live request data (for example a legacy
 * `requests/<token>.txt` entry), and request material must never be echoed.
 */
const CONFIDENTIALITY_ISSUE_CODES = new Set([
  "depth-limit",
  "directory-mode",
  "entries-limit",
  "file-mode",
  "foreign-owner",
  "not-directory",
  "special",
  "stat-error",
  "symlink",
  "type-changed",
  "unreadable-directory",
  "unreadable-file",
  "vanished",
]);

/**
 * A bounded, path-free note for a confidentiality summary: the distinct
 * allowlisted issue codes that were observed, capped so one diagnostic can
 * never grow with the tree. Unknown codes are dropped rather than echoed.
 */
function confidentialityIssueNote(samples) {
  if (!Array.isArray(samples) || samples.length === 0) return "";
  const codes = new Set();
  for (const sample of samples) {
    if (typeof sample?.code === "string" && CONFIDENTIALITY_ISSUE_CODES.has(sample.code)) codes.add(sample.code);
    if (codes.size >= 4) break;
  }
  if (codes.size === 0) return "";
  return ` (issues: ${[...codes].sort().join(", ")})`;
}

async function checkWithContext(context, options) {
  const diagnostics = [];
  const installed = await readRegistry(context);
  if (!installed) diagnostics.push({ level: "error", code: "registry-missing", message: "Registry is missing" });

  // Installed identifiers are untrusted material. One bounded error, and from
  // here on the registry's IDs are inert: no per-skill managed path may be
  // joined or read, and no Claude planning or CLI probe may consume them. The
  // control plane below (installation, ownership marker, confidentiality,
  // spool, legacy requests) observes only fixed router-owned paths and stays
  // available, and the current-config rebuild is source inventory only.
  const installedIdentifiers = installed ? inspectRegistryIdentifiers(installed) : null;
  // Only an *invalid* installed registry disables the ID-consuming probes
  // below; a missing registry keeps its existing reporting behavior.
  const installedIdsUsable = !installedIdentifiers || installedIdentifiers.valid;
  if (installed && !installedIdsUsable) {
    diagnostics.push({
      level: "error",
      code: "registry-invalid-id",
      message: "Registry contains invalid skill or workflow IDs; run skill-router scan to rebuild it",
    });
  }
  // A schema v1 enablement edit the installed registry has not absorbed yet is
  // unhealthy until a scan rebuilds it; routing refuses the same state, so
  // `check` and `route` can never disagree about it. An unusable registry is
  // already reported above and is never consulted here.
  if (installed && installedIdsUsable && staleEnablementIds(installed, context.config).length) {
    diagnostics.push({
      level: "error",
      code: "enablement-stale",
      message: "Registry skill enablement is stale; run skill-router scan to rebuild it",
    });
  }

  const { installation, legacy, problems } = await installationProblems(context.stateDirectory, {
    global: context.global,
  });
  for (const problem of problems) {
    diagnostics.push({ level: "error", code: "installation-invalid", message: problem });
  }
  if (legacy) {
    diagnostics.push({
      level: "warning",
      code: "installation-legacy",
      message: "installation.json is missing; this installation records OpenCode-only",
    });
  }
  const harnesses = selectHarnesses({ recorded: installation?.harnesses, stateExists: legacy });
  if (await directoryExists(context.stateDirectory)) {
    try {
      const marker = await readFile(path.join(context.stateDirectory, ".skill-router-owned"), "utf8");
      if (marker.trim() !== "skill-router-state-v1") throw new Error("unexpected ownership marker");
    } catch (error) {
      diagnostics.push({
        level: "error",
        code: "state-ownership-invalid",
        message: `Router state ownership marker is missing or invalid: ${error.code ?? error.message}`,
      });
    }
  }

  // Confidentiality is an independent, read-only question from attribution:
  // Phase 6 owner-safe legacy modes (0755/0644) keep a state `owned` and
  // regenerable/uninstallable, yet still expose group-readable generated
  // content, so this probe reports that privacy drift separately. Only `drift`
  // is unhealthy; a missing state directory is already covered by the
  // registry/marker diagnostics above, `confidential` is silent, and a
  // platform without uid/mode semantics gets a warning that claims no
  // enforcement at all. Nothing here writes, chmods, or reads a file body.
  //
  // Blocker 3: the diagnostic never carries a filesystem sample path. A
  // relative sample can itself contain live request data (a legacy
  // `requests/<token>.txt` entry), so only the fixed, allowlisted issue codes
  // are reported — never a path, name, token, uid, mode, byte count, or cause.
  const confidentiality = await inspectStateConfidentiality(context.stateDirectory);
  if (confidentiality.status === "drift") {
    diagnostics.push({
      level: "error",
      code: "state-confidentiality-invalid",
      message:
        "Router state is not owner-private (every directory must be exactly 0700 and every file exactly 0600); " +
        "run skill-router init or scan to regenerate it" +
        confidentialityIssueNote(confidentiality.samples),
    });
  } else if (confidentiality.status === "limited") {
    diagnostics.push({
      level: "warning",
      code: "state-confidentiality-limited",
      message: "Router state confidentiality cannot be verified on this platform; no owner-private mode claim is made",
    });
  }

  let current;
  try {
    current = await buildWorkspaceRegistry(context, context.config, { installed });
    diagnostics.push(...current.registry.diagnostics);
    const policyChanged =
      policyFreshnessEnforced(context.config) &&
      installed?.policyHash !== undefined &&
      installed.policyHash !== current.registry.policyHash;
    if (policyChanged) {
      diagnostics.push({ level: "error", code: "policy-stale", message: "Registry routing policy is stale" });
    } else if (installed && installed.fingerprint !== current.registry.fingerprint) {
      diagnostics.push({ level: "error", code: "registry-stale", message: "Registry fingerprint is stale" });
    }
  } catch (error) {
    diagnostics.push({ level: "error", code: "discovery-failed", message: error.message });
  }

  if (harnesses.includes("opencode")) {
    const skillsDirectory = path.join(context.stateDirectory, "opencode-skills");
    try {
      const openCode = parseJsonc(await readJsonText(context.openCodeConfig), context.openCodeConfig);
      if (!configuredSkillSources(openCode).includes(skillsDirectory)) {
        diagnostics.push({ level: "error", code: "opencode-source-missing", message: "OpenCode source is not configured" });
      }
    } catch (error) {
      diagnostics.push({ level: "error", code: "opencode-config-invalid", message: error.message });
    }
    try {
      await access(path.join(skillsDirectory, "skill-router", "SKILL.md"));
    } catch {
      diagnostics.push({ level: "error", code: "router-skill-missing", message: "Generated router skill is missing" });
    }

    // A poisoned installed ID must never be joined to a managed path: this
    // per-skill loop is skipped entirely while the registry is invalid.
    for (const skill of installedIdsUsable ? installed?.skills?.filter((entry) => entry.enabled !== false) ?? [] : []) {
      const managedFile = path.basename(skill.source) === "SKILL.md"
        ? path.join(skillsDirectory, skill.id, "SKILL.md")
        : path.join(skillsDirectory, `${skill.id}.md`);
      try {
        const stat = await lstat(managedFile);
        if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("not a regular file");
        const metadata = skillMetadata(parseFrontmatter(await readFile(managedFile, "utf8")).attributes);
        if (metadata.opencodeAutoinvoke !== false) throw new Error("autoinvoke is not disabled");
      } catch (error) {
        diagnostics.push({
          level: "error",
          code: "managed-skill-invalid",
          skillId: skill.id,
          message: `Managed skill ${skill.id} is not explicitly loadable: ${error.message}`,
        });
      }
    }
  }

  // Claude planning and its CLI probes consume registry IDs to build plugin
  // paths and generated skill names, so an invalid installed registry skips
  // this block entirely — no path join, no file read, no spawned CLI.
  if (harnesses.includes("claude") && installedIdsUsable) {
    try {
      const claudePlan = await planClaudePlugin({
        registry: installed,
        identity: claudeIdentity({ global: context.global, stateDirectory: context.stateDirectory }),
        stateDirectory: context.stateDirectory,
        // The same owner-private planning input the install used: the generated
        // instructions and their fingerprint must reproduce exactly, including
        // the sidecar's recorded mode inputs.
        requestDirectory: context.requestDirectory,
        recorded: installation?.claude ?? null,
        versionMode: "recorded",
      });
      if (installation?.claude?.fingerprint !== claudePlan.fingerprint) {
        diagnostics.push({
          level: "error",
          code: "claude-fingerprint-mismatch",
          message: "Generated Claude plugin fingerprint does not match installation metadata",
        });
      }
      diagnostics.push(...(await verifyClaudePluginFiles({ plan: claudePlan, stateDirectory: context.stateDirectory })));
      diagnostics.push(
        ...(await verifyClaudeRegistration({
          plan: claudePlan.registration,
          installation,
          exec: options.claudeExec,
          cwd: context.root,
          env: options.claudeEnv,
        })),
      );
    } catch (error) {
      diagnostics.push({ level: "error", code: "claude-generation-failed", message: error.message });
    }
  }

  // Request-spool health, read-only: `check` never creates, repairs, or
  // chmods the spool, and it never reads a request body. Only a `ready` spool
  // is healthy; every other classification gets one bounded diagnostic with
  // generic repair guidance and no path, token, entry name, or count.
  const spool = await inspectRequestSpool(context.requestDirectory);
  if (spool.status !== "ready") {
    diagnostics.push({
      level: "error",
      code: "request-spool-invalid",
      message:
        spool.status === "absent"
          ? "Request spool is missing; run skill-router init to create it"
          : "Request spool is missing, unsafe, or unattributed; run skill-router init to create or repair it",
    });
  }
  // Legacy `<state>/requests` predates the stable spool. Pending entries block
  // every managed mutation, so `check` surfaces them; an unsafe directory is
  // reported separately so the repair (inspect, then drain or remove) is clear.
  const legacyRequests = await inspectLegacyRequestDirectory(context.legacyRequestDirectory);
  if (legacyRequests.status === "present") {
    diagnostics.push({
      level: "error",
      code: "legacy-requests-pending",
      message:
        "Legacy request files are pending in router state; consume them with " +
        "skill-router route --request-token before regenerating or uninstalling",
    });
  } else if (legacyRequests.status === "unsafe") {
    diagnostics.push({
      level: "error",
      code: "legacy-request-spool-invalid",
      message: "Legacy request directory is unsafe or unattributed; inspect it before changing router state",
    });
  }

  return {
    command: "check",
    root: context.root,
    healthy: !diagnostics.some((item) => item.level === "error"),
    harnesses,
    diagnostics,
    fingerprint: installed?.fingerprint,
  };
}

/**
 * Bounded, actionable refusal text for observed Claude drift. The reasons come
 * from pure classification, but their count and total length are capped so a
 * hostile or very large registration cannot flood the terminal or a JSON log.
 */
function boundedDriftReasons(reasons) {
  const list = Array.isArray(reasons) ? reasons.filter((value) => typeof value === "string") : [];
  const joined = list.slice(0, 6).join("; ");
  if (!joined) return "the observed registration cannot be attributed to this installation";
  return joined.length > 500 ? `${joined.slice(0, 497)}...` : joined;
}

/** Nested OpenCode summary: never carries raw configuration bytes. */
function uninstallOpenCodeSummary(plan, { dryRun }) {
  if (!plan) return { status: "not-recorded" };
  const rewrite = plan.status === "rewrite";
  return {
    status: dryRun ? (rewrite ? "would-detach" : "already-detached") : rewrite ? "detached" : "already-detached",
    path: plan.file,
    skillsDirectory: plan.skillsDirectory,
    rewritten: dryRun ? false : rewrite,
  };
}

/** Nested Claude summary: identity plus classification, never raw CLI output. */
function uninstallClaudeSummary({ identity, stateDirectory, installation, classification, dryRun, detached }) {
  if (!identity) return { status: "not-recorded" };
  return {
    status: dryRun ? (classification === "healthy" ? "would-detach" : "already-detached") : detached ? "detached" : "already-detached",
    classification,
    scope: identity.claudeScope,
    plugin: identity.plugin,
    marketplace: identity.marketplace,
    marketplaceDirectory: claudePaths(stateDirectory, identity).marketplaceRoot,
    version: installation?.claude?.version ?? null,
  };
}

/**
 * Phase 5 — ownership-aware uninstall.
 *
 * Preflight order matters: owned-state inspection first (truly absent state is
 * an idempotent no-op that never probes another harness), then the read-only
 * OpenCode removal plan — a JSONC/manual configuration refuses here, before any
 * Claude probe — then complete read-only Claude observation and pure
 * classification. Only a healthy registration earns strict generated-source
 * inspection, and only a healthy registration gets external mutation hooks;
 * fully absent Claude state is removed without ever inspecting the generated
 * subtree. `--dry-run` stops after those checks and writes nothing.
 *
 * Real execution is a `applyRemovalTransaction`: the OpenCode config is the
 * only file ever rewritten (the router configuration is never listed), local
 * detach is verified, Claude detach/verification run while state is canonical,
 * ownership is revalidated, and the state rename is the commit. Failures before
 * commit restore the OpenCode bytes and the previously healthy Claude
 * registration; a backup-cleanup failure after commit surfaces as the distinct
 * committed-uninstall error and never claims a rollback.
 */
export async function uninstallOperation(options = {}) {
  if (options.harness !== undefined && options.harness !== null && options.harness !== "") {
    throw new Error("uninstall does not accept a harness selection; it removes every recorded integration");
  }
  return runControlledMutation({
    command: "uninstall",
    options,
    operation: ({ context, paths, lease }) => uninstallWithContext(context, options, { paths, lease }),
  });
}

async function uninstallWithContext(context, options, control) {
  // Same invariant as every mutating build: refuse a configuration that lives
  // inside router-owned state before ownership inspection or any probe.
  await assertConfigOutsideState(context.configFile, context.stateDirectory);
  const dryRun = options.dryRun === true;
  const base = {
    command: "uninstall",
    scope: context.global ? "global" : "project",
    root: context.root,
    stateDirectory: context.stateDirectory,
    configFile: context.configFile,
    openCodeConfig: context.openCodeConfig,
    dryRun,
    configPreserved: true,
  };

  // 0. Request-spool preflight, read-only, before any harness probe, journal,
  //    or external mutation. An absent spool is a legacy install and is fine;
  //    an empty, exactly-owned, marked spool is planned for removal; anything
  //    else — pending entries, claims, unknown names, a foreign or
  //    unattributable directory — refuses generically and preserves every
  //    entry. Legacy requests live inside the state this command removes, so
  //    they refuse too rather than being swept away.
  const spoolPresent = (await assertRequestSpoolEmpty(context.requestDirectory)).present;
  await assertLegacyRequestDirectoryEmpty(context.legacyRequestDirectory);

  // 1. Ownership. Only a truly absent path reports `already-absent`, and that
  //    path returns before any OpenCode or Claude probe.
  const ownership = await readOwnedInstallationForRemoval(context.stateDirectory, { global: context.global });
  if (ownership.status === "absent") {
    return {
      ...base,
      status: "already-absent",
      harnesses: [],
      opencode: { status: "not-recorded" },
      claude: { status: "not-recorded" },
      // A real uninstall still removes a proven-empty spool even when state is
      // already gone; a dry run only reports the plan and touches nothing.
      // Nothing is committed here, so a failure surfaces as itself.
      requestSpool: await settleRequestSpool(context, { spoolPresent, dryRun, committed: false }),
    };
  }
  const { installation, harnesses, stateIdentity } = ownership;
  const skillsDirectory = path.join(context.stateDirectory, "opencode-skills");

  // 2. OpenCode removal plan (pure). A JSONC configuration that still lists the
  //    managed directory refuses here with its exact instruction, before the
  //    Claude CLI is touched at all. A rewrite plan carries the exact bytes it
  //    observed, which the transaction compares against before it writes.
  const openCodePlan = harnesses.includes("opencode")
    ? await planOpenCodeRemoval(context.openCodeConfig, skillsDirectory)
    : null;
  if (openCodePlan?.status === "manual") {
    throw new Error(`Manual change required before uninstall: ${openCodePlan.instruction}`);
  }
  const originalOpenCode = openCodePlan?.status === "rewrite" ? openCodePlan.original : null;

  // 3. Claude read-only observation and classification. Strict generated-source
  //    inspection runs only for a healthy registration, while the state
  //    directory is still canonical.
  const claudeIdentityRecorded = harnesses.includes("claude")
    ? claudeIdentity({ global: context.global, stateDirectory: context.stateDirectory })
    : null;
  let inspected = null;
  let claudeClassification = null;
  // A read-only plan is built for every recorded Claude installation — healthy
  // or already absent — so the final pre-commit re-observation never depends on
  // the strict generated-source inspection that only healthy state earns.
  const claudeReadPlan = claudeIdentityRecorded
    ? claudeRegistrationPlan({
        identity: claudeIdentityRecorded,
        stateDirectory: context.stateDirectory,
        version: installation?.claude?.version ?? null,
      })
    : null;
  if (claudeReadPlan) {
    const observed = await observeClaudeUninstallState({
      plan: claudeReadPlan,
      exec: options.claudeExec,
      cwd: context.root,
      env: options.claudeEnv,
    });
    const evaluated = classifyClaudeUninstallState(observed, claudeReadPlan, installation);
    claudeClassification = evaluated.classification;
    if (claudeClassification === "drift") {
      throw new Error(
        `Claude registration cannot be removed safely: ${boundedDriftReasons(evaluated.reasons)}. ` +
          "Repair it with skill-router init, then run skill-router uninstall again.",
      );
    }
    if (claudeClassification === "healthy") {
      inspected = await inspectGeneratedClaudeRemovalSource({
        identity: claudeIdentityRecorded,
        stateDirectory: context.stateDirectory,
        installation,
        exec: options.claudeExec,
        cwd: context.root,
        env: options.claudeEnv,
      });
    }
  }

  const opencode = uninstallOpenCodeSummary(openCodePlan, { dryRun });
  const claude = uninstallClaudeSummary({
    identity: claudeIdentityRecorded,
    stateDirectory: context.stateDirectory,
    installation,
    classification: claudeClassification,
    dryRun,
    detached: false,
  });

  // 4. Dry-run: every ownership, manual, drift, observation, and strict
  //    generated-source check above already ran; nothing is written or mutated.
  if (dryRun) {
    return {
      ...base,
      status: "would-remove",
      harnesses,
      opencode,
      claude,
      requestSpool: spoolPresent ? "would-remove" : "absent",
    };
  }

  // 5. Real execution.
  const files = [];
  if (openCodePlan?.status === "rewrite") {
    files.push({
      role: "opencode-config",
      path: context.openCodeConfig,
      content: openCodePlan.content,
      // Compare-and-swap against the exact bytes the plan observed: a file
      // changed after planning refuses before anything is written.
      expectedBefore: openCodePlan.original,
    });
  }

  const verifyLocal = openCodePlan
    ? async ({ phase } = {}) => {
        if (phase !== "restored") {
          await verifyOpenCodeRemoval(openCodePlan);
          return;
        }
        if (!originalOpenCode) {
          await verifyOpenCodeRemoval(openCodePlan);
          return;
        }
        let current;
        try {
          current = await readFile(context.openCodeConfig);
        } catch (error) {
          if (error.code === "ENOENT") {
            throw new Error(`OpenCode configuration is missing after rollback: ${context.openCodeConfig}`);
          }
          throw error;
        }
        if (Buffer.compare(current, originalOpenCode) !== 0) {
          throw new Error(`OpenCode configuration was not restored byte for byte: ${context.openCodeConfig}`);
        }
      }
    : undefined;

  // The observed detach plan carries every field the journal's Claude section
  // needs. An absent or unrecorded registration runs with no Claude section at
  // all, so this uninstall never journals an action for state it never touched.
  const detachOptions = inspected
    ? { plan: inspected, installation, exec: options.claudeExec, cwd: context.root, env: options.claudeEnv }
    : null;
  const observeAbsent = async () => {
    const observed = await observeClaudeUninstallState(detachOptions);
    const evaluated = classifyClaudeUninstallState(observed, inspected, installation);
    if (evaluated.classification !== "absent") {
      throw new Error(`Claude registration is not fully detached: ${boundedDriftReasons(evaluated.reasons)}`);
    }
  };

  await applyJournaledRemovalTransaction({
    paths: control.paths,
    lease: control.lease,
    command: "uninstall",
    root: context.root,
    scope: context.global ? "global" : "project",
    stateDirectory: context.stateDirectory,
    stateIdentity,
    files,
    // Same Phase 7 bracket as regeneration: uninstall removes the very state a
    // late legacy request would live in, so it must refuse rather than sweep.
    priorStateGuard: legacyRequestsGuard(context),
    ...(verifyLocal ? { verifyLocal } : {}),
    ...(detachOptions
      ? {
          claude: {
            metadata: {
              reference: claudeReadPlan.reference,
              scope: claudeReadPlan.scope,
              marketplace: claudeReadPlan.identity.marketplace,
              marketplaceRoot: claudeReadPlan.marketplaceRoot,
              version: installation.claude.version,
              prior: "healthy",
              desired: "absent",
            },
          },
          // The observer journals every detach intent and its observed
          // outcome; rollback/recovery re-registers from the restored
          // canonical generated state instead of a pre-detach snapshot.
          applyExternal: ({ observer }) => detachClaude({ ...detachOptions, observer }),
          verifyExternal: observeAbsent,
        }
      : {}),
    // Final commit-boundary check: after ordinary external verification and
    // immediately before ownership revalidation/rename, every recorded
    // integration must still be detached. A source or registration that
    // reappeared during the run aborts pre-commit, so the rollback (and, for
    // initially healthy Claude, the compensation) still has canonical state.
    verifyIntegrations: async () => {
      if (openCodePlan) await verifyOpenCodeRemoval(openCodePlan);
      if (!claudeReadPlan) return;
      const observed = await observeClaudeUninstallState({
        plan: claudeReadPlan,
        exec: options.claudeExec,
        cwd: context.root,
        env: options.claudeEnv,
      });
      const evaluated = classifyClaudeUninstallState(observed, claudeReadPlan, installation);
      if (evaluated.classification !== "absent") {
        const detail = (evaluated.reasons ?? []).length
          ? boundedDriftReasons(evaluated.reasons)
          : "it is registered again";
        throw new Error(`Claude registration must be fully absent before the commit boundary: ${detail}`);
      }
    },
    revalidateOwned: async () => {
      const again = await readOwnedInstallationForRemoval(context.stateDirectory, { global: context.global });
      if (again.status !== "owned") throw new Error("Router state is no longer owned by this installation");
      if (JSON.stringify(again.harnesses) !== JSON.stringify(harnesses)) {
        throw new Error("installation harness metadata changed during uninstall");
      }
    },
    claudeExec: options.claudeExec,
    claudeEnv: options.claudeEnv,
    cwd: context.root,
  });

  // The state and every recorded harness are gone; only now is the spool
  // removed, and only while it is still provably ours and empty. A failure
  // here is reported truthfully rather than claimed as a clean removal — the
  // uninstall itself already committed.
  const requestSpool = await settleRequestSpool(context, { spoolPresent, dryRun: false, committed: true });

  return {
    ...base,
    status: "removed",
    harnesses,
    opencode: uninstallOpenCodeSummary(openCodePlan, { dryRun: false }),
    claude: uninstallClaudeSummary({
      identity: claudeIdentityRecorded,
      stateDirectory: context.stateDirectory,
      installation,
      classification: claudeClassification,
      dryRun: false,
      detached: claudeClassification === "healthy",
    }),
    requestSpool,
  };
}

/**
 * Post-commit (or already-absent) spool settlement for uninstall. A dry run
 * only reports the plan and never creates, chmods, or removes anything; a real
 * run removes a proven-empty spool and reports `removed`/`absent`. A spool
 * that gained an entry concurrently is preserved, and when the uninstall
 * itself already committed the failure surfaces as the distinct committed
 * spool error rather than a false clean removal.
 */
async function settleRequestSpool(context, { spoolPresent, dryRun, committed }) {
  if (!spoolPresent) return "absent";
  if (dryRun) return "would-remove";
  try {
    const removal = await removeRequestSpoolIfEmpty(context.requestDirectory);
    return removal.removed ? "removed" : "absent";
  } catch (error) {
    if (committed && isRequestSpoolError(error)) {
      throw new UninstallCommittedRequestSpoolError(error);
    }
    throw error;
  }
}

/**
 * Thrown when the uninstall itself committed — state and every recorded
 * harness removed — but the stable request spool could not be removed
 * afterwards, because it gained an entry concurrently or is no longer
 * attributable. The spool and all of its entries are preserved; the message
 * carries no path, token, or entry name.
 */
export class UninstallCommittedRequestSpoolError extends Error {
  constructor(cause) {
    super(
      `Uninstall committed, but the request spool could not be removed: ${cause.message}. ` +
        "Its contents were preserved; inspect it and remove it once it is empty.",
    );
    this.name = "UninstallCommittedRequestSpoolError";
    this.code = "UNINSTALL_COMMITTED_REQUEST_SPOOL_FAILED";
    this.committed = true;
  }
}

/**
 * `skill-router recover`: the only command that touches a pending journal
 * without performing a normal mutation. It takes the same lease, validates
 * (or, when a journal needs it, creates) the control anchor, runs only the
 * recovery machine, and returns its bounded result.
 */
export async function recoverOperation(options = {}) {
  return runRecoveryOperation({ command: "recover", options });
}

export const operationInternals = { applyBuild, registryDiff, assertFreshPolicy, blockingDiagnostics };
