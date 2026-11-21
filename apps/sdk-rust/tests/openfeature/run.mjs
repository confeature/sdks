// SPDX-License-Identifier: MIT

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const [separator, ...command] = process.argv.slice(2);
if (separator !== "--" || !command.length) {
  throw new Error("Pass the packed consumer executable after --");
}

const fixtureKey = "configcat-sdk-1/AAAAAAAAAAAAAAAAAAAAAA/BBBBBBBBBBBBBBBBBBBBBB";
const payload = JSON.parse(
  await readFile(
    new URL(
      "../../../../packages/test-fixtures-sdk-parity/fixtures/config-v6.rules.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const harness = new URL(
  "../../../../tools/test-harness-live-contract/dist/cli.js",
  import.meta.url,
);
const guard = new URL("./fixture-proxy.mjs", import.meta.url);
const directory = await mkdtemp(join(tmpdir(), "confeature-openfeature-rust-"));
try {
  const seed = join(directory, "seed.json");
  await writeFile(
    seed,
    JSON.stringify({ schemaVersion: "1.0", keys: [{ sdkKey: fixtureKey, payload }] }),
  );
  const overridden =
    /^(?:cdn_(?:entry|config)|live_harness_url|confeature_live|node_use_env_proxy|(?:npm_config_)?(?:http_|https_|all_|no_)?proxy)$/i;
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !overridden.test(key)),
  );
  env.OPENFEATURE_RUST_FIXTURE_KEY = fixtureKey;
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
      process.execPath,
      fileURLToPath(guard),
      ...command,
    ],
    { env, stdio: "inherit" },
  );
  const forward = (signal) => child.kill(signal);
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
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
  await rm(directory, { force: true, recursive: true });
}
