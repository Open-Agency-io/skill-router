// Phase 15 — public community and governance files.
//
// This file pins the exact minimum public-release set:
//
//   1. the six community files exist at their exact paths;
//   2. the issue templates parse as valid YAML issue-form structures, the
//      bug form carries every required field plus the redaction warning and
//      the Windows-unsupported note, and `.github/ISSUE_TEMPLATE/config.yml`
//      enables blank issues and declares **no** contact links (a contact
//      endpoint must never be invented);
//   3. CONTRIBUTING documents the real commands, gates, platform matrix,
//      dependency/lifecycle policy, privacy contracts, and the `main` PR
//      target — each phrase cross-checked against what actually exists;
//   4. SECURITY pins supported versions (latest 0.1.x only), the published-
//      package provenance (verified `openagency.io` organization scope, the
//      manual no-OIDC-provenance bootstrap of 0.1.0 as history, the
//      configured stage-only trusted publisher whose OIDC claims are proven
//      only per successful workflow run, and the third-party unscoped
//      name), the supply-chain
//      posture, and the private-report
//      contract — including that private vulnerability reporting is an
//      external activation gate this repository does not claim is enabled,
//      that vulnerabilities never go to public issues, and that there is no
//      SLA or security email;
//   5. CODE_OF_CONDUCT is the concise project-specific policy (explicitly
//      not the Contributor Covenant), covers expected/unacceptable
//      behavior, scope, and proportional maintainer moderation, and states
//      honestly that no private conduct-reporting channel is designated;
//   6. README links to all three documents, keeps support scoped to
//      non-sensitive bugs/questions via Issues, keeps security private, and
//      its earlier pinned platform/security phrases are untouched;
//   7. every new document is scanned for email addresses, phone numbers,
//      local absolute paths, secret-shaped strings, and template
//      placeholders, and every occurrence of "SLA" is pinned to a negated
//      claim — no contact, deadline, or service commitment is invented.
//      Both README blocks this phase ships (the Project links block and the
//      support/security section) are scanned alongside the community files;
//   8. the container-gate classification is pinned to the real layers:
//      `test:container` is credential-free and Docker-free and runs inside
//      `npm test`/CI; `container:list|plan|pack` do not invoke Docker;
//      `container:build|smoke|auth-check` require Docker; `container:run`
//      additionally requires model access or credentials; CI executes no
//      live container run — each named script cross-checked against
//      package.json;
//   9. private-reporting activation may only appear as explicit negative
//      wording ("does not claim ... active" / "instead of claiming ...") —
//      a bare positive phrase ("vulnerability reporting is enabled",
//      "channel is active", …) fails the suite in any shipped document;
//  10. the issue templates are validated against a local schema: exact
//      allowed keys at the top level, per-field, and per-validation level
//      (attributes are allowlisted subsets), known field types only, a
//      kebab-case id regex with unique ids, nonempty labels, nonempty
//      dropdown options, checkbox options with exactly {label, required}
//      and required === true, and `config.yml` with exactly the two known
//      keys and their exact types/values;
//  11. the npm `files` allowlist is unchanged and `npm pack --dry-run`
//      still ships exactly 29 entries (package.json + README.md + LICENSE +
//      26 src modules) with **no** community file ever entering the tarball.
//
// Everything is read-only: the files are parsed, README/package metadata are
// read, and one `npm pack --dry-run` (no tarball, no scratch directory, no
// network) confirms the packed shape.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const COMMUNITY_FILES = [
  "CONTRIBUTING.md",
  "SECURITY.md",
  "CODE_OF_CONDUCT.md",
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  ".github/ISSUE_TEMPLATE/config.yml",
  ".github/pull_request_template.md",
];

const packageJson = JSON.parse(readFileSync(path.join(repository, "package.json"), "utf8"));
const readme = readFileSync(path.join(repository, "README.md"), "utf8");
const readmeFlat = readme.replace(/\s+/g, " ");

function community(file) {
  return readFileSync(path.join(repository, file), "utf8");
}

function communityFlat(file) {
  return community(file).replace(/\s+/g, " ");
}

/** The exact slice of README this phase adds, between its two headings. */
function readmeSection(title, nextTitle) {
  const start = readme.indexOf(title);
  const end = readme.indexOf(nextTitle, start);
  assert.ok(start !== -1 && end !== -1 && end > start, `README section ${title} must exist before ${nextTitle}`);
  return readme.slice(start, end);
}

const supportSectionFlat = readmeSection("## Support, contributing, and security", "## Install").replace(/\s+/g, " ");
const projectLinksFlat = readmeSection("## Project links", "## Support, contributing, and security").replace(/\s+/g, " ");

const bugForm = parse(community(".github/ISSUE_TEMPLATE/bug_report.yml"));
const issueConfig = parse(community(".github/ISSUE_TEMPLATE/config.yml"));

test("the six community files exist at their exact repository paths", () => {
  for (const file of COMMUNITY_FILES) {
    assert.ok(existsSync(path.join(repository, file)), `${file} must exist`);
    assert.ok(community(file).length > 0, `${file} must not be empty`);
  }
  // Nothing in the allowed write set is misplaced.
  assert.ok(!existsSync(path.join(repository, "SUPPORT.md")), "no SUPPORT.md: README/CONTRIBUTING carry support");
  assert.ok(!existsSync(path.join(repository, ".github", "CODEOWNERS")), "no CODEOWNERS without known ownership data");
  assert.ok(!existsSync(path.join(repository, ".github", "FUNDING.yml")), "no FUNDING.yml without funding data");
});

test("the issue templates parse as valid structures with no invented contact links", () => {
  // ---- Local schema: exact allowed keys at every level ------------------
  // GitHub's issue-form schema is validated here against an explicit
  // allowlist, so an unknown key (a typo, a silently ignored field, or a
  // smuggled contact) fails the suite instead of shipping unnoticed.
  const TOP_LEVEL_KEYS = ["name", "description", "body"];
  const FIELD_TYPES = ["markdown", "input", "textarea", "dropdown", "checkboxes"];
  const KEYS_BY_TYPE = {
    markdown: ["type", "attributes"],
    input: ["type", "id", "attributes", "validations"],
    textarea: ["type", "id", "attributes", "validations"],
    dropdown: ["type", "id", "attributes", "validations"],
    // Checkboxes carry no `validations` block: each option's own `required`
    // flag is what makes a confirmation mandatory.
    checkboxes: ["type", "id", "attributes"],
  };
  const ATTRIBUTE_KEYS = {
    markdown: ["value"],
    input: ["label", "description", "placeholder"],
    textarea: ["label", "description", "placeholder", "render"],
    dropdown: ["label", "description", "options"],
    checkboxes: ["label", "options"],
  };
  const VALIDATION_KEYS = ["required"];
  const ID_PATTERN = /^[a-z]+(?:-[a-z]+)*$/;

  // config.yml: exact keys, exact types, exact values.
  assert.deepEqual(Object.keys(issueConfig).sort(), ["blank_issues_enabled", "contact_links"], "config holds exactly the two known keys");
  assert.equal(typeof issueConfig.blank_issues_enabled, "boolean", "blank_issues_enabled is a boolean");
  assert.equal(issueConfig.blank_issues_enabled, true, "blank issues stay enabled");
  assert.ok(Array.isArray(issueConfig.contact_links), "contact_links is an array");
  assert.deepEqual(issueConfig.contact_links, [], "no contact links — a contact endpoint must never be invented");

  // Top level: exact allowed keys, and exactly the set this file ships.
  assert.deepEqual(Object.keys(bugForm).sort(), [...TOP_LEVEL_KEYS].sort(), "the form holds exactly name, description, body — no title/labels/assignees");
  assert.equal(typeof bugForm.name, "string");
  assert.ok(bugForm.name.length > 0, "the form has a name");
  assert.equal(typeof bugForm.description, "string");
  assert.ok(bugForm.description.length > 0, "the form has a description");
  assert.ok(Array.isArray(bugForm.body) && bugForm.body.length > 0, "the form has a body");

  const byId = new Map();
  for (const entry of bugForm.body) {
    assert.ok(entry && typeof entry === "object" && !Array.isArray(entry), "every body entry is an object");
    const label = entry.id ?? entry.type;
    assert.ok(FIELD_TYPES.includes(entry.type), `known field type: ${entry.type}`);

    // Exact allowed keys per field type — markdown carries no id or
    // validations; every other field carries all four keys.
    assert.deepEqual(
      Object.keys(entry).sort(),
      [...KEYS_BY_TYPE[entry.type]].sort(),
      `${label}: exact allowed keys for type ${entry.type}`,
    );

    // Attributes: keys must be a subset of the per-type allowlist (no
    // unknown/smuggled keys), and the type-specific attributes GitHub
    // requires to render the field at all must be present.
    assert.ok(entry.attributes && typeof entry.attributes === "object" && !Array.isArray(entry.attributes), `${label}: attributes is an object`);
    for (const key of Object.keys(entry.attributes)) {
      assert.ok(ATTRIBUTE_KEYS[entry.type].includes(key), `${label}: attribute key "${key}" is allowed for type ${entry.type}`);
    }
    if (entry.type === "markdown") {
      assert.equal(typeof entry.attributes.value, "string", `${label}: markdown carries a string value`);
      assert.ok(entry.attributes.value.length > 0, `${label}: markdown value is nonempty`);
      continue;
    }

    assert.equal(typeof entry.attributes.label, "string", `${label}: label is a string`);
    assert.ok(entry.attributes.label.length > 0, `${label}: label is nonempty`);
    if (entry.type === "dropdown" || entry.type === "checkboxes") {
      assert.ok("options" in entry.attributes, `${label}: ${entry.type} carries options`);
    }

    assert.equal(typeof entry.id, "string", `${label}: id is a string`);
    assert.ok(ID_PATTERN.test(entry.id), `${label}: id is kebab-case (${entry.id})`);
    assert.ok(!byId.has(entry.id), `field ids are unique: ${entry.id}`);
    byId.set(entry.id, entry);

    // Validations: exact allowed keys on the types that carry them;
    // `required` is a boolean. Checkboxes have no validations block.
    if (entry.type !== "checkboxes") {
      assert.ok(entry.validations !== undefined, `${label}: carries validations`);
      assert.deepEqual(Object.keys(entry.validations).sort(), [...VALIDATION_KEYS].sort(), `${label}: validations hold only required`);
      assert.equal(typeof entry.validations.required, "boolean", `${label}: required is a boolean`);
    } else {
      assert.ok(!("validations" in entry), `${label}: checkboxes carry no validations block`);
    }
  }

  for (const id of ["skill-router-version", "node-version", "operating-system", "harness", "scope", "reproduction", "expected", "actual"]) {
    assert.ok(byId.has(id), `the bug form asks for ${id}`);
    assert.equal(byId.get(id).validations.required, true, `${id} is required`);
  }

  // Dropdown: nonempty options of nonempty strings.
  const os = byId.get("operating-system");
  assert.ok(Array.isArray(os.attributes.options) && os.attributes.options.length > 0, "the dropdown carries nonempty options");
  for (const option of os.attributes.options) {
    assert.equal(typeof option, "string", "each dropdown option is a string");
    assert.ok(option.trim().length > 0, "each dropdown option is nonempty");
  }
  assert.deepEqual(
    os.attributes.options.map((option) => option.split(" ")[0]),
    ["Linux", "macOS"],
    "the OS dropdown offers exactly Linux and macOS",
  );
  assert.ok(os.attributes.description.includes("PLATFORM_UNSUPPORTED"), "the OS description states the Windows refusal code");
  assert.ok(/Windows is unsupported/.test(os.attributes.description), "the OS description states Windows is unsupported");

  // The redaction warning is the first thing a reporter reads.
  const intro = bugForm.body[0];
  assert.equal(intro.type, "markdown", "the form opens with guidance");
  const introFlat = intro.attributes.value.replace(/\s+/g, " ");
  assert.ok(/never include request bodies/i.test(introFlat), "the intro warns against posting request bodies");
  assert.ok(/spool tokens/i.test(introFlat), "the intro warns against posting spool tokens");
  assert.ok(/digests/i.test(introFlat), "the intro warns against posting digests");
  assert.ok(/sensitive local filesystem paths/i.test(introFlat), "the intro warns against posting sensitive paths");
  assert.ok(/Security vulnerabilities do not belong here/i.test(introFlat), "the intro redirects vulnerabilities to SECURITY.md");
  assert.ok(introFlat.includes("SECURITY.md"), "the intro links the security policy");

  // Checkboxes: every option has exactly {label, required}, required is
  // the boolean true, and the labels carry the three confirmations.
  const confirmations = bugForm.body.find((entry) => entry.type === "checkboxes");
  assert.ok(Array.isArray(confirmations.attributes.options), "checkbox options are an array");
  const labels = confirmations.attributes.options.map((option) => {
    assert.deepEqual(Object.keys(option).sort(), ["label", "required"], "each checkbox option holds exactly label and required");
    assert.equal(typeof option.label, "string", "checkbox label is a string");
    assert.ok(option.label.length > 0, "checkbox label is nonempty");
    assert.equal(option.required, true, `each confirmation is required: ${option.label}`);
    return option.label;
  });
  assert.equal(labels.length, 3, "exactly the three confirmation checkboxes");
  assert.ok(labels.some((label) => label.includes("searched existing issues")), "existing-issue search is confirmed");
  assert.ok(labels.some((label) => /redacted request bodies, tokens, digests/.test(label)), "redaction is confirmed");
  assert.ok(labels.some((label) => label.includes("not a security vulnerability")), "the security redirect is confirmed");
});

test("CONTRIBUTING documents the real commands, gates, matrix, and policies", () => {
  const flat = communityFlat("CONTRIBUTING.md");

  // Setup and required gates — the exact commands the repository actually has.
  assert.ok(flat.includes("Node.js 20 or newer"), "the Node minimum is stated");
  assert.ok(flat.includes("npm ci"), "npm ci is documented");
  assert.ok(flat.includes("npm test"), "npm test is documented");
  assert.ok(flat.includes("npm run check"), "npm run check is documented");
  assert.ok(flat.includes("gate:clean"), "the optional clean-candidate gate is documented");
  assert.ok(flat.includes("node src/cli.js"), "the pre-publish CLI invocation is documented");
  assert.ok(flat.includes("`skill-router` bin name only exists"), "the pre-publish bin caveat is stated");
  assert.ok(flat.includes("Pull requests target `main`"), "PRs target main");
  assert.ok(flat.includes("SKILL_ROUTER_HOME"), "the isolated-home affordance is documented");
  assert.ok(flat.includes("optional maintainer gates"), "container/model gates are marked optional");

  // Container classification — the exact Docker/credential split, pinned
  // so the documented layers can never drift from the real ones.
  assert.ok(flat.includes("credential-free and Docker-free"), "test:container is credential- and Docker-free");
  assert.ok(flat.includes("already runs inside `npm test`"), "test:container runs inside npm test and therefore inside CI");
  assert.ok(flat.includes("without invoking Docker"), "container:list/plan/pack do not invoke Docker");
  assert.ok(flat.includes("require Docker"), "container:build/smoke/auth-check require Docker");
  assert.ok(flat.includes("builds the required harness images"), "container:build creates rather than requires pre-existing images");
  assert.ok(
    flat.includes("explicit model configuration and corresponding credentials"),
    "container:run additionally needs model configuration and corresponding credentials",
  );
  assert.ok(flat.includes("CI executes no live container run"), "CI is documented as executing no live container run");
  for (const name of ["test:container", "container:list", "container:plan", "container:pack", "container:build", "container:smoke", "container:auth-check", "container:run"]) {
    assert.ok(name in packageJson.scripts, `package.json actually has the ${name} script`);
    assert.ok(flat.includes(name), `CONTRIBUTING names ${name}`);
  }

  // Platform matrix — exactly the Phase 14 contract.
  assert.ok(flat.includes("The only CI- and release-gated platform"), "Linux is the gated platform");
  assert.ok(flat.includes("no macOS CI job"), "the missing macOS CI job is stated");
  assert.ok(flat.includes("not CI-qualified"), "macOS is not CI-qualified");
  assert.ok(flat.includes("PLATFORM_UNSUPPORTED"), "the Windows refusal code is named");
  assert.ok(flat.includes('"os": ["darwin", "linux"]'), "the npm os contract is quoted");
  assert.ok(flat.includes("must not claim live Windows or macOS CI evidence"), "no live cross-platform evidence may be claimed");

  // Contracts a change must not regress.
  assert.ok(
    flat.includes("request bytes, request bodies, spool tokens, and") &&
      flat.includes("their digests are never exposed in any error, result, record, or"),
    "the request-privacy contract is documented",
  );
  for (const code of ["REQUEST-IDENTITY-UNAVAILABLE", "RECOVERY_CONFLICT", "LOCK_COMPROMISED"]) {
    assert.ok(flat.includes(code), `the stable error code ${code} is named`);
  }
  assert.ok(flat.includes("same-UID"), "the threat-model exclusion is named");
  assert.ok(flat.includes("Never") && flat.includes("post vulnerabilities"), "vulnerabilities are kept out of public issues");

  // Package policy.
  assert.ok(flat.includes("No lifecycle scripts, ever"), "lifecycle scripts are forbidden");
  assert.ok(flat.includes("exactly pinned `yaml`"), "the single pinned dependency is named");
  assert.ok(flat.includes('["src", "README.md", "LICENSE"]'), "the npm files allowlist is quoted");
  assert.ok(flat.includes("no new runtime dependencies without discussion") || flat.includes("No new runtime dependencies without discussion"), "new deps require discussion");

  // Cross-check the commands CONTRIBUTING advertises against reality.
  const scripts = packageJson.scripts;
  for (const name of ["test", "check"]) {
    assert.ok(name in scripts, `package.json actually has the ${name} script`);
  }
  assert.ok("gate:clean" in scripts, "package.json actually has the gate:clean script");
  assert.deepEqual(packageJson.bin, { "skill-router": "./src/cli.js" }, "the documented bin target is the real one");
  assert.ok(existsSync(path.join(repository, "src", "cli.js")), "node src/cli.js resolves");
  assert.equal(packageJson.engines.node, ">=20", "the documented Node minimum is the declared engines range");
});

test("SECURITY pins versions, provenance, supply chain, and the private-report contract", () => {
  const flat = communityFlat("SECURITY.md");

  // Supported versions: latest 0.1.x only, pre-1.0, no backports.
  assert.ok(flat.includes("latest `0.1.x`"), "only the latest 0.1.x line is supported");
  assert.ok(flat.includes("pre-1.0"), "the pre-1.0 status is stated");
  assert.ok(flat.includes("no backporting"), "no backporting is promised");
  assert.ok(flat.includes("no long-term support"), "no long-term support is promised");

  // Provenance: published package, verified organization scope, third-party name.
  assert.ok(/The package \*\*is published\*\*/.test(flat), "the package is documented as published");
  assert.ok(
    !flat.includes("not published") && !flat.includes("unpublished"),
    "no stale unpublished claim survives in SECURITY",
  );
  assert.ok(flat.includes("@openagency.io/skill-router"), "the verified package name is documented");
  assert.ok(/ownership was[^.]*verified/i.test(flat), "the organization ownership is documented as verified");
  assert.ok(!flat.includes("unconfirmed"), "the retired unconfirmed-scope claim is gone");
  assert.ok(!flat.includes("@openagency/skill-router"), "the retired provisional package name is gone");
  assert.ok(flat.includes("0.0.0-stage"), "the first bootstrap placeholder is documented");
  assert.ok(
    /no\s+trusted-publisher\/OIDC provenance/.test(flat),
    "the bootstrapped first version is documented as lacking OIDC provenance",
  );
  assert.ok(flat.includes("is configured"), "the trusted publisher is documented as configured");
  assert.ok(!flat.includes("not configured"), "the stale unconfigured claim is gone");
  assert.ok(
    flat.includes("only after a successful run"),
    "OIDC actor/provenance claims are bound to a successful workflow run",
  );
  assert.ok(flat.includes("unrelated third-party"), "the unscoped name is documented as third-party");
  assert.ok(flat.includes("must never be installed or suggested"), "the squatted name is forbidden");
  assert.ok(flat.includes("unofficial"), "any other registry package claiming to be Skill Router is unofficial");

  // Supply-chain posture.
  assert.ok(flat.includes("No lifecycle scripts"), "the no-lifecycle-scripts posture is stated");
  assert.ok(flat.includes("SHA256SUMS"), "checksummed releases are documented");
  assert.ok(flat.includes("--ignore-scripts"), "the ignore-scripts publication design is documented");
  assert.ok(flat.includes("least-privilege") || flat.includes("Least-privilege"), "CI least privilege is documented");
  assert.ok(flat.includes("One pinned runtime dependency"), "the single pinned dependency is documented");

  // Private reporting: the exact repository advisory URL, honestly gated.
  assert.ok(
    flat.includes("https://github.com/Open-Agency-io/skill-router/security/advisories/new"),
    "the private advisory URL is the repository's own",
  );
  assert.ok(flat.includes("external release gate"), "repository-setting activation is an external release gate");
  assert.ok(flat.includes("does **not** claim it is already active"), "the policy does not claim the channel is enabled");
  assert.ok(flat.includes("must be confirmed in repository settings"), "activation must be confirmed before public release");
  assert.ok(flat.includes("Do **not** open a public issue"), "vulnerabilities are never reported through public issues");

  // No SLA, no invented security email or bounty.
  assert.ok(flat.includes("no response-time SLA"), "no response SLA is promised");
  assert.ok(flat.includes("no dedicated security email address"), "no security email is invented");
  assert.ok(flat.includes("no bug-bounty program"), "no bounty program is promised");
});

test("CODE_OF_CONDUCT is a concise project policy with proportional moderation and no invented channel", () => {
  const flat = communityFlat("CODE_OF_CONDUCT.md");

  // Concise and project-specific — explicitly not the Contributor Covenant.
  assert.ok(flat.includes("not** the Contributor Covenant"), "it is explicitly not the Contributor Covenant");
  assert.ok(flat.includes("does **not** have a designated private reporting channel") || flat.includes("does not (yet) have a"), "the reason it is not the Covenant is stated");
  assert.ok(community("CODE_OF_CONDUCT.md").split("\n").length < 100, "the policy stays concise");

  // Expected and unacceptable behavior, scope, enforcement.
  assert.ok(flat.includes("## Expected behavior"), "expected behavior is documented");
  assert.ok(flat.includes("## Unacceptable behavior"), "unacceptable behavior is documented");
  assert.ok(flat.includes("## Scope"), "scope is documented");
  assert.ok(flat.includes("## Enforcement"), "enforcement is documented");
  assert.ok(flat.includes("Maintainers may moderate repository participation"), "maintainers moderate repository participation");
  assert.ok(flat.includes("Proportional responses"), "moderation is proportional");
  for (const step of ["a reminder", "hiding or locking", "closing, labeling, or rejecting", "temporary or permanent blocking"]) {
    assert.ok(flat.includes(step), `the proportional step "${step}" is listed`);
  }

  // The honest limitation: no private channel, no contact, no SLA.
  assert.ok(flat.includes("No private conduct-reporting channel is designated yet"), "the missing private channel is stated honestly");
  assert.ok(flat.includes("does not invent an email address or endpoint"), "no contact is invented");
  assert.ok(flat.includes("resolved **before** this project claims one exists"), "designation is a prerequisite for claiming a channel");
  assert.ok(flat.includes("no** enforcement\n  response-time SLA") || flat.includes("enforcement response-time SLA"), "no enforcement SLA is promised");
  assert.ok(flat.includes("public GitHub profile"), "the only fallback is a contact a maintainer actually lists");
});

test("README links the community files and keeps support and security correctly scoped", () => {
  // Every document is linked from the Project links section and the new
  // support section.
  for (const file of ["CONTRIBUTING.md", "SECURITY.md", "CODE_OF_CONDUCT.md"]) {
    assert.ok(readme.includes(`](${file})`), `README links ${file}`);
  }
  assert.ok(readme.includes("## Support, contributing, and security"), "README carries the new support section");
  assert.ok(supportSectionFlat.includes("non-sensitive bugs and usage questions"), "support is scoped to non-sensitive matters");
  assert.ok(supportSectionFlat.includes("Do not post vulnerabilities or sensitive personal data in"), "sensitive data stays out of public issues");
  assert.ok(supportSectionFlat.includes("never through a\n  public issue") || supportSectionFlat.includes("never through a public issue"), "security reports never go through a public issue");
  assert.ok(supportSectionFlat.includes("external release gate"), "the activation gate is surfaced in README");
  assert.ok(supportSectionFlat.includes("does not\n  claim the channel is already active") || supportSectionFlat.includes("does not claim the channel is already active") || supportSectionFlat.includes("instead of\n  claiming the channel is already active") || supportSectionFlat.includes("claiming the channel is already active"), "README does not claim the private channel is active");
  assert.ok(supportSectionFlat.includes("Pull requests target `main`"), "the PR target is stated");
  assert.ok(supportSectionFlat.includes("private reporting contact because none is designated yet"), "the CoC limitation is surfaced in README");

  // Every relative markdown link in README resolves to a real file.
  const relative = [...readme.matchAll(/\]\((?!https?:)([^)#]+)\)/g)].map((match) => match[1]);
  assert.ok(relative.length >= 3, "README carries the community relative links");
  for (const target of relative) {
    assert.ok(existsSync(path.join(repository, target)), `README link ${target} must resolve`);
  }

  // The earlier pinned platform/security phrases survive this additive edit.
  assert.ok(readmeFlat.includes("## Platform support (Phase 14)"), "the platform section is untouched");
  assert.ok(readmeFlat.includes("not CI-qualified"), "the macOS caveat survives");
  assert.ok(readmeFlat.includes("PLATFORM_UNSUPPORTED"), "the Windows refusal survives");
  assert.ok(readmeFlat.includes("published to npm"), "the published-package statement survives");
});

test("the new community documents carry no contact data, secrets, local paths, or placeholders", () => {
  // Both README blocks this phase ships are scanned alongside the community
  // files: the Project links block and the support/security section.
  const scanned = [
    ...COMMUNITY_FILES.map((file) => ({ file, text: community(file) })),
    { file: "README.md (Project links block)", text: projectLinksFlat },
    { file: "README.md (support section)", text: supportSectionFlat },
  ];

  for (const { file, text } of scanned) {
    const email = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g);
    assert.deepEqual(email, null, `${file} must carry no email address, found ${email}`);

    const phone = text.match(/(?:\+\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/g);
    assert.deepEqual(phone, null, `${file} must carry no phone number, found ${phone}`);

    for (const pattern of [/\/Users\//, /\/home\/[A-Za-z]/, /\/tmp\//, /C:\\/, /\/var\/folders\//]) {
      assert.ok(!pattern.test(text), `${file} must carry no local absolute path (${pattern})`);
    }

    for (const pattern of [/ghp_[A-Za-z0-9]/, /github_pat_[A-Za-z0-9]/, /sk-[A-Za-z0-9]{16}/, /AKIA[0-9A-Z]{16}/, /Bearer\s+[A-Za-z0-9]/, /_authToken/, /[0-9a-f]{32,}/i]) {
      assert.ok(!pattern.test(text), `${file} must carry no secret-shaped string (${pattern})`);
    }

    for (const pattern of [/\[INSERT/i, /\[CONTACT/i, /your\.email/, /example\.(com|org|net)/, /\bTBD\b/, /\bFIXME\b/, /123-456-7890/]) {
      assert.ok(!pattern.test(text), `${file} must carry no template placeholder (${pattern})`);
    }

    // Every mention of "SLA" must be a negated promise, never a commitment.
    const slas = [...text.matchAll(/SLA/g)];
    for (const match of slas) {
      const before = text.slice(Math.max(0, match.index - 64), match.index).toLowerCase();
      assert.ok(
        /\bno\b|\bnon\b/.test(before),
        `${file}: every SLA mention must be negated, found near "${text.slice(Math.max(0, match.index - 64), match.index + 3)}"`,
      );
    }
  }

  // Pinned SLA negations: one in SECURITY, one in the CoC.
  assert.equal((community("SECURITY.md").match(/SLA/g) || []).length, 1, "SECURITY carries exactly one SLA mention");
  assert.equal((community("CODE_OF_CONDUCT.md").match(/SLA/g) || []).length, 1, "the CoC carries exactly one SLA mention");
  assert.equal((supportSectionFlat.match(/SLA/g) || []).length, 0, "the README support section promises no SLA at all");
  assert.equal((projectLinksFlat.match(/SLA/g) || []).length, 0, "the README Project links block promises no SLA at all");

  // Private-reporting activation: only the explicit negative wording is
  // acceptable. SECURITY must carry "does not claim ... active", README must
  // carry the negative construction, and no shipped document may contain a
  // bare positive activation phrase.
  assert.ok(
    communityFlat("SECURITY.md").includes("does **not** claim it is already active"),
    "SECURITY carries the explicit negative activation wording",
  );
  assert.ok(
    supportSectionFlat.includes("instead of claiming the channel is already active"),
    "README carries the negative activation construction",
  );
  assert.ok(
    supportSectionFlat.includes("must be confirmed in repository settings before public release"),
    "README states activation must be confirmed before public release",
  );
  for (const { file, text } of scanned) {
    for (const pattern of [
      /vulnerability reporting is (?:enabled|active)/i,
      /reporting (?:channel )?is (?:already )?(?:enabled|active)\b/i,
      /private vulnerability reporting (?:is|has been) enabled/i,
      /\bis enabled for (?:this|the) repositor/i,
    ]) {
      assert.ok(!pattern.test(text), `${file} must never claim the private-reporting channel is active (${pattern})`);
    }
  }
});

test("npm pack still ships only the allowlisted surfaces — never the community files", (t) => {
  assert.deepEqual(
    packageJson.files,
    ["src", "README.md", "LICENSE"],
    "the npm files allowlist is unchanged by Phase 15",
  );

  const probe = spawnSync("npm", ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    t.skip("npm is unavailable");
    return;
  }
  const packed = spawnSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
    cwd: repository,
    encoding: "utf8",
    timeout: 120000,
  });
  assert.equal(packed.status, 0, `npm pack --dry-run failed: ${packed.stderr}`);
  const [report] = JSON.parse(packed.stdout);
  assert.equal(report.name, packageJson.name);
  assert.equal(report.version, packageJson.version);

  const shipped = report.files.map((entry) => entry.path).sort();
  const sourceModules = readdirSync(path.join(repository, "src"))
    .filter((name) => name.endsWith(".js"))
    .map((name) => `src/${name}`)
    .sort();
  const intended = ["LICENSE", "README.md", "package.json", ...sourceModules].sort();

  assert.deepEqual(shipped, intended, "the tarball is exactly package.json + README + LICENSE + src modules");
  assert.equal(sourceModules.length, 26, "26 shipped source modules — unchanged by Phase 15");
  assert.equal(report.entryCount, 29, "29 packed entries before and after Phase 15 — community files are never packed");

  const forbidden = ["CONTRIBUTING.md", "SECURITY.md", "CODE_OF_CONDUCT.md", ".github/pull_request_template.md"];
  for (const file of forbidden) {
    assert.ok(!shipped.includes(file), `${file} must never enter the tarball`);
  }
  assert.equal(shipped.filter((name) => name.startsWith(".github/")).length, 0, "no .github file is ever packed");
});
