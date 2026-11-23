// SPDX-License-Identifier: MIT

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, "../..");
const cli = resolve(
  process.argv[2] ?? resolve(root, "tools/test-harness-live-contract/dist/cli.js"),
);
if (!existsSync(cli)) {
  console.error("Build the live-contract harness or pass its compiled CLI path.");
  process.exit(2);
}
const preparedPackage = process.env.SWIFT_OPENFEATURE_PACKAGE_PATH;
const packagePath = resolve(preparedPackage ?? resolve(root, "apps/sdk-swift-openfeature"));
const suitePaths = preparedPackage
  ? ["config", "cache", "security"].flatMap((storage) => [
      `--${storage}-path`,
      resolve(packagePath, ".swiftpm", `native-${storage}`),
    ])
  : [];
const env = { ...process.env };
for (const key of [
  "CDN_ENTRY",
  "CDN_CONFIG",
  "CDN_BASE_URL",
  "CONFEATURE_LIVE",
  "LIVE_HARNESS_URL",
  "NODE_USE_ENV_PROXY",
  ...Object.keys(env).filter((name) => /^(http|https|all|no)_proxy$/i.test(name)),
]) {
  delete env[key];
}

const result = spawnSync(
  process.execPath,
  [
    cli,
    "--seed",
    resolve(directory, "seed.json"),
    "--exec",
    "--",
    "xcrun",
    "swift",
    "test",
    "--package-path",
    packagePath,
    ...suitePaths,
    "--force-resolved-versions",
    "--skip-build",
    "--filter",
    "LoopbackTests",
  ],
  { cwd: root, env, encoding: "utf8" },
);
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
if (result.error) console.error(result.error.message);
if (result.status !== 0) process.exit(result.status ?? 1);
// XCTest reports success even when the harness is absent and both cases skip.
if (!/Executed 2 tests, with 0 failures/.test(result.stdout) || / skipped\b/.test(result.stdout)) {
  console.error("Expected both OpenFeature provider loopback tests to run without skips.");
  process.exit(1);
}
