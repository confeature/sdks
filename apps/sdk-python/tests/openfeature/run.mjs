// SPDX-License-Identifier: MIT

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const [separator, ...command] = process.argv.slice(2);
if (separator !== "--" || !command.length) {
  throw new Error("Pass the Python test or wheel probe command after --");
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
const directory = await mkdtemp(join(tmpdir(), "confeature-openfeature-python-"));
try {
  const seedPath = join(directory, "seed.json");
  await writeFile(
    seedPath,
    JSON.stringify({ schemaVersion: "1.0", keys: [{ sdkKey: fixtureKey, payload }] }),
  );
  process.exitCode = await executeSuite(seedPath);
} finally {
  await rm(directory, { recursive: true, force: true });
}

function executeSuite(seedPath) {
  const filtered =
    /^(?:cdn_(?:entry|config)|live_harness_url|confeature_live|node_use_env_proxy|(?:npm_config_)?(?:http_|https_|all_|no_)?proxy)$/i;
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !filtered.test(name)),
  );
  env.OPENFEATURE_PYTHON_FIXTURE_KEY = fixtureKey;
  const child = spawn(
    process.execPath,
    [fileURLToPath(harness), "--bind", "127.0.0.1", "--seed", seedPath, "--exec", "--", ...command],
    { env, stdio: "inherit" },
  );
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
