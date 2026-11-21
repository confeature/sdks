// SPDX-License-Identifier: MIT

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const fixtureKey = "configcat-sdk-1/AAAAAAAAAAAAAAAAAAAAAA/BBBBBBBBBBBBBBBBBBBBBB";
const payload = JSON.parse(
  await readFile(
    new URL(
      "../../packages/test-fixtures-sdk-parity/fixtures/config-v6.rules.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const harness = new URL("../test-harness-live-contract/dist/cli.js", import.meta.url);
const directory = await mkdtemp(join(tmpdir(), "confeature-openfeature-java-"));
try {
  const seed = join(directory, "seed.json");
  await writeFile(
    seed,
    JSON.stringify({ schemaVersion: "1.0", keys: [{ sdkKey: fixtureKey, payload }] }),
  );
  const inherited =
    /^(?:cdn_(?:entry|config|base_url)|live_harness_url|confeature_live|openfeature_java_.*|(?:npm_config_)?(?:http_|https_|all_|no_)?proxy|node_use_env_proxy|java_tool_options|jdk_java_options|_java_options|gradle_opts|java_opts)$/i;
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !inherited.test(key)),
  );
  env.OPENFEATURE_JAVA_FIXTURE_KEY = fixtureKey;
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(harness),
      "--bind",
      "127.0.0.1",
      "--seed",
      seed,
      "--exec",
      "--",
      "sh",
      "apps/sdk-java/openfeature/gradlew",
      "--no-daemon",
      "--max-workers=2",
      "-PuseLocalConfeatureSdk=true",
      "openFeatureSmoke",
    ],
    { env, stdio: "inherit" },
  );
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  const forward = (signal) => child.kill(signal);
  for (const signal of signals) process.on(signal, forward);
  try {
    process.exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
    });
  } finally {
    for (const signal of signals) process.off(signal, forward);
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
