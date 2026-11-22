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
    resolve(root, "apps/sdk-swift-openfeature"),
    "--skip-build",
    "--filter",
    "LoopbackTests",
  ],
  { cwd: root, env, stdio: "inherit" },
);
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
