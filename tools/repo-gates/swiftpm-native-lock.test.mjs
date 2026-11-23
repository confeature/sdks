// SPDX-License-Identifier: MIT

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { sdkGateFindings } from "./verify-workflows.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (file) => readFileSync(join(root, file), "utf8");
const officialRevision = "19c0de402027db6b69bf055b134f3123ea97f2f2";

function nativeSuite(revision) {
  const folder = mkdtempSync(join(tmpdir(), "swiftpm-native-lock-"));
  try {
    const commandLog = join(folder, "commands");
    const pinsPath = join(folder, "pins.json");
    const fakeSwift = join(folder, "swift.mjs");
    writeFileSync(join(folder, "xcrun"), "#!/bin/sh\nprintf '/fixture-sdk\\n'\n", { mode: 0o755 });
    writeFileSync(
      pinsPath,
      JSON.stringify({
        pins: [
          {
            identity: "swift-sdk",
            kind: "remoteSourceControl",
            location: "https://github.com/open-feature/swift-sdk.git",
            state: { version: "0.7.0", revision },
          },
          { identity: "confeature-swift", location: "file:///temporary-base" },
        ],
      }),
    );
    writeFileSync(
      fakeSwift,
      `import { appendFileSync, copyFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.COMMAND_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "package" && args.includes("resolve"))
  copyFileSync(process.env.PINS_PATH, "Package.resolved");
`,
    );
    const result = spawnSync(
      "bash",
      ["scripts/swift-openfeature-suite.sh", process.execPath, fakeSwift],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_ENV: join(folder, "github-env"),
          TMPDIR: folder,
          PATH: `${folder}:${process.env.PATH}`,
          COMMAND_LOG: commandLog,
          PINS_PATH: pinsPath,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_ALLOW_PROTOCOL: "file",
        },
      },
    );
    return {
      ...result,
      calls: readFileSync(commandLog, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    };
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

it("the native suite refuses a moved OpenFeature tag before testing or building", () => {
  const result = nativeSuite("0".repeat(40));
  expect(result.stderr).toContain("Unexpected SwiftPM resolution for swift-sdk");
  expect(result.status).toBe(1);
  expect(result.calls.map(([command]) => command)).toEqual(["package", "package"]);
});

it("the native suite resolves before running tests and four builds with the verified lockfile", () => {
  const result = nativeSuite(officialRevision);
  expect(result.status, result.stderr).toBe(0);
  const { calls } = result;
  expect(calls.map(([command]) => command)).toEqual([
    "package",
    "package",
    "test",
    "build",
    "build",
    "build",
    "build",
  ]);
  expect(calls[1]).toContain("resolve");
  for (const call of calls) {
    expect(call).toEqual(
      expect.arrayContaining(["--security-path", "--cache-path", "--config-path"]),
    );
  }
  for (const call of calls.slice(2)) expect(call).toContain("--force-resolved-versions");
});

it.each(["conditional setup", "late setup"])(
  "the native workflow gate refuses %s of Node",
  (fault) => {
    const doc = parse(read(".github/workflows/sdk-gates.yml"));
    const steps = doc.jobs.swift.steps;
    const nodeIndex = steps.findIndex((step) => step.uses?.startsWith("actions/setup-node@"));
    if (fault === "conditional setup") steps[nodeIndex].if = "matrix.sdk.live";
    else steps.push(...steps.splice(nodeIndex, 1));
    const findings = sdkGateFindings({
      settings: JSON.parse(read("tools/repo-gates/release-settings.json")),
      manifest: JSON.parse(read("dagger/sdk-manifest.json")),
      workflows: { "sdk-gates.yml": doc },
    });
    expect(findings).toContainEqual(
      expect.objectContaining({
        job: "swift",
        why: expect.stringMatching(
          /actions\/setup-node@.*step before its native suite that runs unconditionally/,
        ),
      }),
    );
  },
);
