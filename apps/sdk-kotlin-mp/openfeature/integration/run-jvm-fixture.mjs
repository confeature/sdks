// SPDX-License-Identifier: MIT

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const fixtureKey = "configcat-sdk-1/AAAAAAAAAAAAAAAAAAAAAA/BBBBBBBBBBBBBBBBBBBBBB";
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const companion = fileURLToPath(new URL("../", import.meta.url));
const base = fileURLToPath(new URL("../../", import.meta.url));
const runFile = fileURLToPath(import.meta.url);

const payload = {
  f: {
    region: {
      t: 1,
      v: { s: "true" },
      i: "region-default",
      r: [
        {
          c: [{ u: { a: "Country", c: 0, l: ["FR"] } }],
          s: { v: { s: "00123" }, i: "region-match" },
        },
      ],
    },
  },
};

async function run(command, args, options) {
  const child = spawn(command, args, { stdio: "inherit", ...options });
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  const forward = (signal) => child.kill(signal);
  for (const signal of signals) process.on(signal, forward);
  try {
    return await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
    });
  } finally {
    for (const signal of signals) process.off(signal, forward);
  }
}

const root = await mkdtemp(join(tmpdir(), "cf-kotlin-openfeature-"));
try {
  if (process.argv[2] === "--fixture-child") {
    const origin = process.env.LIVE_HARNESS_URL;
    if (process.env.CONFEATURE_LIVE !== "1" || !origin) {
      throw new Error("The committed harness must supply the live fixture origin.");
    }
    const stage = join(root, "sdk");
    const stageScript = fileURLToPath(new URL("stage-sdk.mjs", import.meta.url));
    if ((await run(process.execPath, [stageScript, base, stage, origin])) !== 0) {
      throw new Error("Could not stage the guarded Kotlin SDK.");
    }
    const sources = join(root, "test-sources");
    await mkdir(sources);
    await writeFile(
      join(sources, "FixtureOrigin.kt"),
      `// SPDX-License-Identifier: MIT
package io.confeature.kmp.openfeature

internal const val FIXTURE_KEY = "${fixtureKey}"
internal const val FIXTURE_ORIGIN = "${origin}"
`,
    );
    const code = await run(
      "sh",
      [
        "./gradlew",
        "--include-build",
        stage,
        "--no-daemon",
        "--max-workers=2",
        `-PfixtureSources=${sources}`,
        "jvmTest",
        "--rerun",
        "--tests",
        "io.confeature.kmp.openfeature.NetworkFixtureTest",
      ],
      { cwd: companion },
    );
    if (code !== 0) {
      process.exitCode = code;
    } else {
      const endpoint = new URL("/admin/requests", origin);
      endpoint.searchParams.set("sdkKey", fixtureKey);
      const response = await fetch(endpoint, {
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      });
      const report = await response.json();
      const request = report.requests?.[0];
      if (
        !response.ok ||
        !report.ok ||
        report.requests.length !== 1 ||
        request.ifNoneMatch !== null ||
        new URL(request.url, origin).pathname !==
          `/configuration-files/${fixtureKey}/config_v6.json`
      ) {
        throw new Error("The Kotlin fixture must make exactly one seeded initial config request.");
      }
    }
  } else {
    const seed = join(root, "seed.json");
    await writeFile(
      seed,
      JSON.stringify({ schemaVersion: "1.0", keys: [{ sdkKey: fixtureKey, payload }] }),
    );
    const inherited =
      /^(?:cdn_(?:entry|config|base_url)|live_harness_url|confeature_live|(?:npm_config_)?(?:http_|https_|all_|no_)?proxy|node_use_env_proxy|java_tool_options|jdk_java_options|_java_options|gradle_opts|java_opts)$/i;
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !inherited.test(name)),
    );
    process.exitCode = await run(
      process.execPath,
      [
        join(repoRoot, "tools/test-harness-live-contract/dist/cli.js"),
        "--bind",
        "127.0.0.1",
        "--seed",
        seed,
        "--exec",
        "--",
        process.execPath,
        runFile,
        "--fixture-child",
      ],
      { cwd: repoRoot, env },
    );
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
