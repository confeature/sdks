// SPDX-License-Identifier: MIT

import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const [separator, ...command] = process.argv.slice(2);
if (separator !== "--" || command.length === 0) {
  throw new Error("Pass the installed PHP consumer command after --");
}
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
const directory = await mkdtemp(join(tmpdir(), "confeature-openfeature-php-"));
let unexpectedConnections = 0;
const canary = createServer((_req, res) => res.writeHead(500).end());
canary.on("connection", () => {
  ++unexpectedConnections;
});

try {
  canary.listen(0, "127.0.0.1");
  await once(canary, "listening");
  const seed = join(directory, "seed.json");
  await writeFile(
    seed,
    JSON.stringify({ schemaVersion: "1.0", keys: [{ sdkKey: fixtureKey, payload }] }),
  );
  const filters =
    /^(?:cdn_(?:entry|config|base_url)|live_harness_url|confeature_live|openfeature_php_.*|node_use_env_proxy|(?:npm_config_)?(?:http_|https_|all_|no_)?proxy)$/i;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !filters.test(key)));
  env.OPENFEATURE_PHP_FIXTURE_KEY = fixtureKey;
  env.OPENFEATURE_PHP_CANARY_URL = `http://127.0.0.1:${canary.address().port}`;
  const child = spawn(
    process.execPath,
    [fileURLToPath(harness), "--bind", "127.0.0.1", "--seed", seed, "--exec", "--", ...command],
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
  if (unexpectedConnections !== 0) {
    throw new Error(`Fixture canary received ${unexpectedConnections} unexpected connection(s)`);
  }
  console.log("PHP fixture canary received zero destination connections");
} finally {
  if (canary.listening) {
    canary.closeAllConnections();
    await new Promise((resolve, reject) =>
      canary.close((error) => (error ? reject(error) : resolve())),
    );
  }
  await rm(directory, { recursive: true, force: true });
}
