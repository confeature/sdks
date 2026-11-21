// SPDX-License-Identifier: MIT

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const fixtureKey = "configcat-sdk-1/AAAAAAAAAAAAAAAAAAAAAA/BBBBBBBBBBBBBBBBBBBBBB";
const lazyKey = "configcat-sdk-1/CCCCCCCCCCCCCCCCCCCCCC/DDDDDDDDDDDDDDDDDDDDDD";
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const companion = fileURLToPath(new URL("../", import.meta.url));
const base = fileURLToPath(new URL("../../", import.meta.url));
const runFile = fileURLToPath(import.meta.url);
const pathFor = (key) => `/configuration-files/${key}/config_v6.json`;
const configPath = pathFor(fixtureKey);
const lazyPath = pathFor(lazyKey);
const redirectPath = `/fixture-redirect${configPath}`;
const runtimes = {
  jvm: ["jvmTest"],
  android: ["-PenableAndroid=true", "testDebugUnitTest"],
  node: ["jsNodeTest"],
  browser: ["jsBrowserTest"],
  apple: ["iosSimulatorArm64Test"],
};
const childMode = process.argv[2] === "--fixture-child";
const target = process.argv[childMode ? 3 : 2] ?? "jvm";
if (!Object.hasOwn(runtimes, target)) {
  throw new Error("Choose a Kotlin fixture target: jvm, android, node, browser or apple.");
}

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
const lazySeed = (value) => ({
  sdkKey: lazyKey,
  payload: { f: { region: { t: 1, v: { s: value }, i: value } } },
  etag: `"kotlin-${value}"`,
});

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

function loopbackOrigin(value) {
  const url = new URL(value);
  if (
    value !== url.origin ||
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    Number(url.port) < 1024
  ) {
    throw new Error("The fixture must supply a numeric loopback origin.");
  }
  return url.origin;
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function close(server) {
  server.closeAllConnections();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function updateLazySeed(harness) {
  const response = await fetch(harness + "/admin/seed", {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ keys: [lazySeed("fresh")] }),
  });
  if (!response.ok || (await response.json()).appliedKeys !== 1) {
    throw new Error("The local harness did not update the LazyLoad fixture.");
  }
}

function createFixtureServers(harness) {
  let connections = 0;
  let seeded = 0;
  let redirects = 0;
  let lazyRequests = 0;
  const canary = createServer((_, response) => response.writeHead(404).end());
  canary.on("connection", () => connections++);
  const expectedTransport = target === "node" || target === "browser" ? target : undefined;
  const facade = createServer(async (request, response) => {
    if (
      request.method !== "GET" ||
      request.headers["x-kotlin-fixture-transport"] !== expectedTransport
    ) {
      response.writeHead(400).end();
      return;
    }
    if (request.url === redirectPath) {
      redirects++;
      const destination = `http://127.0.0.1:${canary.address().port}`;
      response.writeHead(302, { location: destination + configPath }).end();
      return;
    }
    if (request.url !== configPath && request.url !== lazyPath) {
      response.writeHead(404).end();
      return;
    }
    const updateSeed = request.url === lazyPath && ++lazyRequests === 1;
    try {
      const upstream = await fetch(harness + request.url, {
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
        headers: request.headers["if-none-match"]
          ? { "if-none-match": request.headers["if-none-match"] }
          : {},
      });
      const body = Buffer.from(await upstream.arrayBuffer());
      if (updateSeed) await updateLazySeed(harness);
      seeded++;
      const headers = { "content-type": "application/json", "cache-control": "no-store" };
      const etag = upstream.headers.get("etag");
      if (etag) headers.etag = etag;
      response.writeHead(upstream.status, headers).end(body);
    } catch (error) {
      console.error("The local Kotlin fixture upstream failed.", error);
      response.writeHead(502).end();
    }
  });
  return { canary, facade, counts: () => ({ seeded, redirects, connections }) };
}

async function checkRequests(harness, key, expected) {
  const endpoint = new URL("/admin/requests", harness);
  endpoint.searchParams.set("sdkKey", key);
  const response = await fetch(endpoint, {
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  const report = await response.json();
  if (
    !response.ok ||
    !report.ok ||
    report.requests.length !== expected ||
    report.requests[0].ifNoneMatch !== null ||
    report.requests.some((r) => new URL(r.url, harness).pathname !== pathFor(key)) ||
    (key === lazyKey && report.requests[1].ifNoneMatch !== lazySeed("stale").etag)
  ) {
    throw new Error(`Unexpected manual or LazyLoad request sequence for the ${target} fixture.`);
  }
}

async function checkTestResults(task) {
  for (const [name, minimum] of [
    ["ConsumerSmokeTest", 2],
    ["NetworkFixtureTest", 3],
  ]) {
    const report = await readFile(
      join(
        companion,
        "build",
        "test-results",
        task,
        `TEST-io.confeature.kmp.openfeature.${name}.xml`,
      ),
      "utf8",
    );
    const suite = /<testsuite\b[^>]*>/.exec(report)?.[0] ?? "";
    const count = Number(/\btests="(\d+)"/.exec(suite)?.[1] ?? 0);
    if (
      count < minimum ||
      !["skipped", "failures", "errors"].every((key) => suite.includes(`${key}="0"`))
    ) {
      throw new Error(`${task} did not run and pass the expected ${name} cases.`);
    }
  }
}

async function exercise(root, harness) {
  const { canary, facade, counts } = createFixtureServers(harness);
  const destination = await listen(canary);
  try {
    const facadeOrigin = await listen(facade);
    let origin = facadeOrigin;
    if (target === "browser") {
      // Karma serves the test bundle and the two approved fixture routes on one origin.
      const reservation = createServer();
      origin = await listen(reservation);
      await close(reservation);
    }
    const stage = join(root, "sdk");
    const stageScript = fileURLToPath(new URL("stage-sdk.mjs", import.meta.url));
    if ((await run(process.execPath, [stageScript, base, stage, origin, target])) !== 0) {
      throw new Error("Could not stage the guarded Kotlin SDK.");
    }
    const sources = join(root, "test-sources");
    await mkdir(sources);
    await writeFile(
      join(sources, "FixtureOrigin.kt"),
      `// SPDX-License-Identifier: MIT
package io.confeature.kmp.openfeature

internal const val FIXTURE_KEY = "${fixtureKey}"
internal const val FIXTURE_LAZY_KEY = "${lazyKey}"
internal const val FIXTURE_ORIGIN = "${origin}"
internal const val FIXTURE_CANARY_ORIGIN = "${destination}"
`,
    );
    const simulator =
      target === "apple"
        ? [`-PfixtureSimulator=${process.env.CONFEATURE_KOTLIN_SIMULATOR ?? ""}`]
        : [];
    if (
      target === "apple" &&
      !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(
        process.env.CONFEATURE_KOTLIN_SIMULATOR ?? "",
      )
    ) {
      throw new Error("The Apple fixture needs the UUID of the dedicated simulator.");
    }
    const code = await run(
      "sh",
      [
        "./gradlew",
        "--include-build",
        stage,
        "--no-daemon",
        "--max-workers=2",
        "-Pkotlin.compiler.execution.strategy=in-process",
        `-PfixtureSources=${sources}`,
        ...simulator,
        ...runtimes[target],
        "--rerun",
      ],
      {
        cwd: companion,
        env: {
          ...process.env,
          CONFEATURE_KOTLIN_BROWSER_ORIGIN: target === "browser" ? origin : "",
          CONFEATURE_KOTLIN_BROWSER_FACADE: target === "browser" ? facadeOrigin : "",
        },
      },
    );
    if (code !== 0) return code;

    await checkTestResults(runtimes[target].at(-1));
    await checkRequests(harness, fixtureKey, 1);
    await checkRequests(harness, lazyKey, 2);
    const { seeded, redirects, connections } = counts();
    if (seeded !== 3 || redirects !== 1 || connections !== 0) {
      throw new Error(
        "Expected three seeded requests, one local redirect response and zero canary connections.",
      );
    }
    console.log(`Verified Kotlin ${target}: manual and LazyLoad reads, zero canary connections.`);
    return 0;
  } finally {
    try {
      if (facade.listening) await close(facade);
    } finally {
      await close(canary);
    }
  }
}

const root = await mkdtemp(join(tmpdir(), "cf-kotlin-openfeature-"));
try {
  if (childMode) {
    const origin = process.env.LIVE_HARNESS_URL;
    if (process.env.CONFEATURE_LIVE !== "1" || !origin) {
      throw new Error("The committed harness must supply the live fixture origin.");
    }
    process.exitCode = await exercise(root, loopbackOrigin(origin));
  } else {
    const seed = join(root, "seed.json");
    await writeFile(
      seed,
      JSON.stringify({
        schemaVersion: "1.0",
        keys: [{ sdkKey: fixtureKey, payload }, lazySeed("stale")],
      }),
    );
    const inherited =
      /^(?:cdn_(?:entry|config|base_url)|live_harness_url|confeature_live|confeature_kotlin_browser_.*|(?:npm_config_)?(?:http_|https_|all_|no_)?proxy|node_use_env_proxy|java_tool_options|jdk_java_options|_java_options|gradle_opts|java_opts)$/i;
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
        target,
      ],
      { cwd: repoRoot, env },
    );
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
