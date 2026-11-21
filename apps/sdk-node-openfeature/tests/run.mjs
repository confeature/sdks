// SPDX-License-Identifier: MIT

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { fixtureKey } from "./seed.mjs";

const require = createRequire(import.meta.url);
const fixture =
  require.resolve("@confeature/test-fixtures-sdk-parity/fixtures/config-v6.rules.json");
const harness = dirname(require.resolve("@confeature/test-harness-live-contract/package.json"));
const directory = await mkdtemp(join(tmpdir(), "confeature-openfeature-"));
try {
  const seedPath = join(directory, "seed.json");
  const payload = JSON.parse(await readFile(fixture, "utf8"));
  await writeFile(
    seedPath,
    JSON.stringify({ schemaVersion: "1.0", keys: [{ sdkKey: fixtureKey, payload }] }),
  );
  process.exitCode = await executeSuite(join(harness, "dist/cli.js"), seedPath);
} finally {
  await rm(directory, { recursive: true, force: true });
}

function executeSuite(harnessCli, seedPath) {
  const filtered =
    /^(?:cdn_(?:entry|config)|live_harness_url|confeature_live|node_use_env_proxy|(?:npm_config_)?(?:http_|https_|all_|no_)?proxy)$/i;
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !filtered.test(name)),
  );
  const args = [
    harnessCli,
    "--seed",
    seedPath,
    "--exec",
    "--",
    "vp",
    "test",
    ...process.argv.slice(2),
  ];
  const child = spawn(process.execPath, args, { env, stdio: "inherit" });

  const forward = (signal) => child.kill(signal);
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  }).finally(() => {
    process.off("SIGINT", forward);
    process.off("SIGTERM", forward);
  });
}
