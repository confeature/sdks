// SPDX-License-Identifier: MIT

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { checkSwiftPMResolved } from "../sdk-pack/check-swiftpm-resolved.mjs";
import { resolvePublish } from "../sdk-pack/resolve-publish.mjs";
import { classifyPath } from "./select-sdks.mjs";
import { findings } from "./verify-workflows.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const REPO = "confeature/confeature-swift-openfeature";
const REGISTRY = "swiftpm-openfeature";
const PACK = "pack-swiftpm-openfeature";
const PUBLISH = "publish-swiftpm-openfeature";
const ENV = "sdk-publish-swiftpm-openfeature";
const workflow = parse(
  readFileSync(new URL("../../.github/workflows/sdk-publish.yml", import.meta.url), "utf8"),
);
const manifest = JSON.parse(
  readFileSync(new URL("../../dagger/sdk-manifest.json", import.meta.url), "utf8"),
);
const settings = JSON.parse(
  readFileSync(new URL("./release-settings.json", import.meta.url), "utf8"),
);

it("resolves the Swift companion's tag and dry run to the same independent mirror route", async () => {
  const resolveTag = (options) => resolvePublish({ root: ROOT, ...options });
  const dry = await resolveTag({ unit: "openfeature-swift", version: "0.1.0" });
  const tagged = await resolveTag({
    tag: "sdk-openfeature-swift-v0.1.0",
    mainRef: "origin/main",
    isOnMain: () => true,
  });
  expect(tagged).toEqual(dry);
  expect(dry).toMatchObject({
    registry: REGISTRY,
    path: "apps/sdk-swift-openfeature",
    coordinates: `https://github.com/${REPO}`,
    mirrorRepository: REPO,
    mirrorTag: "0.1.0",
  });
});

it("scopes the bundle and SSH key to the companion's publish leg", () => {
  const pack = workflow.jobs[PACK];
  const publish = workflow.jobs[PUBLISH];
  expect(pack.if).toContain(`needs.setup.outputs.registry == '${REGISTRY}'`);
  expect(pack.environment).toBeUndefined();
  expect(pack.permissions).toEqual({ contents: "read" });
  expect(pack.steps.map((step) => step.run ?? "")).toContain(
    "bash tools/sdk-pack/check-swiftpm-consumer.sh openfeature",
  );
  expect(publish.environment).toBe(ENV);
  expect(publish.needs).toEqual(["setup", PACK]);
  expect(publish.if).toContain("github.event_name == 'push'");
  expect(publish.steps.flatMap((step) => step.run ?? "").join("\n")).toContain(
    `git@github.com:${REPO}.git`,
  );
  expect(publish.steps.some((step) => step.uses?.startsWith("actions/checkout@"))).toBe(false);
  expect(workflow.jobs.conclude.needs).toEqual(expect.arrayContaining([PACK, PUBLISH]));
  expect(settings.environments.find((entry) => entry.name === ENV)).toMatchObject({
    registry: REGISTRY,
    secrets: [{ name: "MIRROR_DEPLOY_KEY", kind: "deploy-key" }],
  });
  expect(settings.mirrors.find((entry) => entry.repository === REPO)).toMatchObject({
    unit: "openfeature-swift",
    environment: ENV,
    deployKeyTitle: ENV,
  });
});

const PRECHECK = "bash scripts/swift-precheck.sh";
const HARNESS = "pnpm --filter @confeature/test-harness-live-contract build";
const LIVE = "node tools/sdk-swift-openfeature/run.mjs";
const PACK_FILE = "sdk-publish.yml";

const companionFindings = (doc) =>
  findings({ manifest, settings, workflows: { [PACK_FILE]: doc } }).filter(
    (finding) => finding.job === PACK && finding.why.includes("SwiftPM companion"),
  );

it("requires native validation, harness build and loopback in separate ordered steps", () => {
  expect(companionFindings(workflow)).toEqual([]);
  const runs = workflow.jobs[PACK].steps.map((step) => step.run);
  const native = runs.indexOf(PRECHECK);
  expect(native).toBeGreaterThanOrEqual(0);
  expect(runs.indexOf(HARNESS)).toBeGreaterThan(native);
  expect(runs.indexOf(LIVE)).toBeGreaterThan(runs.indexOf(HARNESS));
});

const takeRun = (steps, command) =>
  steps.splice(
    steps.findIndex((step) => step.run === command),
    1,
  )[0];

it.each([
  ["missing precheck", (steps) => takeRun(steps, PRECHECK)],
  ["missing harness", (steps) => takeRun(steps, HARNESS)],
  ["missing loopback", (steps) => takeRun(steps, LIVE)],
  [
    "loopback combined with the native precheck",
    (steps) => {
      steps.find((step) => step.run === PRECHECK).run = `${PRECHECK}\n${LIVE}`;
      takeRun(steps, LIVE);
    },
  ],
  ["skipped loopback", (steps) => (steps.find((step) => step.run === LIVE).if = "false")],
  [
    "an ignored loopback failure",
    (steps) => (steps.find((step) => step.run === LIVE)["continue-on-error"] = true),
  ],
  ["loopback after upload", (steps) => steps.push(takeRun(steps, LIVE))],
  ["harness before native precheck", (steps) => steps.unshift(takeRun(steps, HARNESS))],
  [
    "missing public pin check",
    (steps) =>
      takeRun(
        steps,
        'node tools/sdk-pack/check-swiftpm-resolved.mjs "$RUNNER_TEMP/consume/consumer/Package.resolved"',
      ),
  ],
])("the workflow verifier refuses %s in the companion pack job", (_label, mutate) => {
  const doc = structuredClone(workflow);
  mutate(doc.jobs[PACK].steps);
  expect(companionFindings(doc)).not.toHaveLength(0);
});

const pin = (identity, location, version, revision) => ({
  identity,
  kind: "remoteSourceControl",
  location,
  state: { version, revision },
});
const publicPins = [
  pin("confeature-swift", "https://github.com/confeature/confeature-swift.git", "0.2.0"),
  pin(
    "swift-sdk",
    "https://github.com/open-feature/swift-sdk.git",
    "0.7.0",
    "19c0de402027db6b69bf055b134f3123ea97f2f2",
  ),
  pin("swift-log", "https://github.com/apple/swift-log", "1.9.0"),
];

it("accepts the public base, official OpenFeature and SwiftLog from the consumer", () => {
  expect(() => checkSwiftPMResolved({ pins: publicPins })).not.toThrow();
});

it.each([
  ["an old base", 0, { state: { version: "0.1.1" } }],
  ["another minor of the base", 0, { state: { version: "0.3.0" } }],
  ["a local base", 0, { location: "file:///tmp/confeature-swift" }],
  ["the base test's ConfigCat SDK", 1, { location: "https://github.com/configcat/swift-sdk.git" }],
  ["a different OpenFeature version", 1, { state: { ...publicPins[1].state, version: "0.7.1" } }],
  ["a moved OpenFeature tag", 1, { state: { version: "0.7.0", revision: "0".repeat(40) } }],
  ["an OpenFeature pin without a revision", 1, { state: { version: "0.7.0" } }],
  ["a duplicate pin", 2, publicPins[0]],
])("refuses %s in the consumer lockfile", (_label, index, replacement) => {
  const pins = publicPins.map((entry, i) => (index === i ? { ...entry, ...replacement } : entry));
  expect(() => checkSwiftPMResolved({ pins })).toThrow(/Unexpected SwiftPM resolution/);
});

it("refuses an added transitive dependency", () => {
  const pins = [...publicPins, pin("additional", "https://example.com/additional.git", "1.0.0")];
  expect(() => checkSwiftPMResolved({ pins })).toThrow(/Expected only/);
});

it("routes changes to the companion through the pinned native Swift gate", () => {
  expect(classifyPath("apps/sdk-swift-openfeature/Package.swift", new Set(["swift"]))).toBe(
    "swift",
  );
});

it.each([
  ["two passing tests", "Executed 2 tests, with 0 failures", 0],
  ["no tests", "Executed 0 tests, with 0 failures", 1],
  ["skipped tests", "case skipped\nExecuted 2 tests, with 0 failures", 1],
])("the seeded provider runner handles %s", (_label, log, status) => {
  const folder = mkdtempSync(join(tmpdir(), "swiftpm-loopback-"));
  try {
    const cli = join(folder, "fake-harness.mjs");
    writeFileSync(
      cli,
      `if (!process.argv.includes(process.env.SWIFT_OPENFEATURE_PACKAGE_PATH)) process.exit(2);
console.log(${JSON.stringify(log)});`,
    );
    const result = spawnSync(
      process.execPath,
      [join(ROOT, "tools/sdk-swift-openfeature/run.mjs"), cli],
      { env: { ...process.env, SWIFT_OPENFEATURE_PACKAGE_PATH: folder } },
    );
    expect(result.status).toBe(status);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
