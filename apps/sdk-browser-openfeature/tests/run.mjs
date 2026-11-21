// SPDX-License-Identifier: MIT

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createSeed } from "./seed.mjs";

const require = createRequire(import.meta.url);
const harness = dirname(require.resolve("@confeature/test-harness-live-contract/package.json"));
const vitePlus = dirname(require.resolve("vite-plus/package.json"));
const directory = await mkdtemp(join(tmpdir(), "confeature-openfeature-browser-"));

try {
  const seedPath = join(directory, "seed.json");
  const reportPath = join(directory, "test-report.json");
  await writeFile(seedPath, JSON.stringify(createSeed()));

  const code = await executeSuite(join(harness, "dist/cli.js"), [
    "--seed",
    seedPath,
    "--exec",
    "--",
    process.execPath,
    join(vitePlus, "bin/vp"),
    "test",
    "run",
    ...process.argv.slice(2),
    "--reporter=default",
    "--reporter=json",
    `--outputFile.json=${reportPath}`,
  ]);
  if (code === 0) await checkReport(reportPath);
  process.exitCode = code;
} finally {
  await rm(directory, { recursive: true, force: true });
}

function executeSuite(harnessCli, args) {
  const filtered =
    /^(?:cdn_(?:entry|config)|live_harness_url|confeature_live|node_use_env_proxy|(?:npm_config_)?(?:http_|https_|all_|no_)?proxy)$/i;
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !filtered.test(name)),
  );
  const child = spawn(process.execPath, [harnessCli, ...args], { env, stdio: "inherit" });
  const sigint = () => child.kill("SIGINT");
  const sigterm = () => child.kill("SIGTERM");
  process.on("SIGINT", sigint);
  process.on("SIGTERM", sigterm);

  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  }).finally(() => {
    process.off("SIGINT", sigint);
    process.off("SIGTERM", sigterm);
  });
}

async function checkReport(path) {
  const { numTotalTests, numPassedTests, numPendingTests, numTodoTests } = JSON.parse(
    await readFile(path, "utf8"),
  );
  if (
    !(numTotalTests > 0) ||
    numPassedTests !== numTotalTests ||
    numPendingTests !== 0 ||
    numTodoTests !== 0
  ) {
    throw new Error("The OpenFeature fixture suite must execute and pass every selected test.");
  }
}
