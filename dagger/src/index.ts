/**
 * Confeature Dagger module — Phase 3 (4 platform-majors + wire-cases).
 *
 * Phase 2 (#201, merged 2026-05-27) introduced `jsTest()` running sdk-node's
 * vitest suite inside `node:22.23.3-bookworm-slim`. Phase 3 (#202) widens this to:
 *
 *   - `jsTest`        sdk-node           (Phase 2, preserved verbatim)
 *   - `browserTest`   sdk-browser-js     (NEW — shares the node container)
 *   - `pythonTest`    sdk-python         (NEW — python:3.13-bookworm-slim + uv)
 *   - `goTest`        sdk-go             (NEW — golang:1.23-bookworm + staticcheck)
 *   - `wireCases`     sdk-node + sdk-browser-js tests/wire/  (NEW)
 *   - `prepushAll`    orchestrator       (NEW — Promise.all over the 5 above)
 *
 * The hook (root package.json `simple-git-hooks.pre-push`) invokes
 * `pnpm dagger:all`, which gates on Dagger CLI + Docker availability and then
 * calls `prepushAll`. Red OR > 5 min aggregate blocks the push (SC-001 hard
 * assertion). Per-family aliases (`pnpm dagger:{js,browser,python,go,wire}`)
 * exist for single-family debugging (FR-010) and intentionally do NOT enforce
 * SC-001 — the aggregate budget only applies to `prepushAll`.
 *
 * Image pin policy (research R18): `<major>-<os-family>` tags only — no
 * `:latest`, no `@sha256:` digests. Bumping a pin requires an explicit PR.
 *
 * Cache volume names (research R17, total ~850 MB warm steady state):
 *   - pnpm-store, pnpm-vstore      (jsTest / browserTest / wireCases)
 *   - uv-cache, uv-python          (pythonTest)
 *   - go-mod-cache, go-build-cache (goTest)
 *
 * Full design: spec 053 (the Dagger local runner).
 */
import { dag, Container, Directory, Platform, object, func } from "@dagger.io/dagger";

// SC-001 + Principle VII line 168 — "≤ 5 minutes wall-clock"
const BUDGET_MS = 300_000;

/**
 * The JS family's Node image, exact (FR-008): `nodeContainer`'s base, and the
 * Node runtime copied into every other toolchain that runs a live suite.
 */
const NODE_IMAGE = "node:22.23.3-bookworm-slim";

/**
 * Build the shared JS-family container (node:22.23.3-bookworm-slim + pnpm caches +
 * frozen-lockfile install). Used by `jsTest`, `browserTest`, and `wireCases`.
 *
 * The Container is a Dagger lazy graph node — adding more `.withExec(...)` to
 * the returned value does NOT re-run the install layer. Dagger's content-addressable
 * scheduler dedupes the install across all three callers when invoked under one
 * session (i.e. inside `prepushAll`).
 *
 * Observable behaviour MUST stay byte-identical to Phase 2's `jsTest` chain — the
 * helper is a private TS-level refactor, not exposed via @func() to the Dagger
 * schema. See spec 053 T004.
 */
function nodeContainer(source: Directory, platform?: Platform): Container {
  // A foreign platform gets its own install caches: a virtual store holds the
  // platform's native optional dependencies (workerd, esbuild) and its hidden
  // lockfile, which one platform's install must not hand to another's.
  const caches = platform === undefined ? "" : `-${platform.replace(/\W+/g, "-")}`;
  return (
    dag
      .container(platform === undefined ? undefined : { platform })
      .from(NODE_IMAGE)
      .withEnvVariable("CI", "true")
      .withExec([
        "bash",
        "-c",
        "apt-get update >/dev/null && apt-get install -y --no-install-recommends git ca-certificates >/dev/null && rm -rf /var/lib/apt/lists/*",
      ])
      // Two cache volumes mounted OUTSIDE /work to avoid the EBUSY rmdir conflict
      // documented in research R3 (Phase 2) + spike #346. The relocated virtual store
      // (`--virtual-store-dir=/pnpm/vstore`) means pnpm's "Recreating node_modules"
      // step rmdirs a path inside /work/node_modules/.pnpm — now an EMPTY directory
      // (not a mount point), so EBUSY no longer fires.
      .withMountedCache("/root/.local/share/pnpm/store", dag.cacheVolume(`pnpm-store${caches}`))
      .withMountedCache("/pnpm/vstore", dag.cacheVolume(`pnpm-vstore${caches}`))
      .withMountedDirectory("/work", source)
      .withWorkdir("/work")
      .withExec(["corepack", "enable"])
      .withExec(["pnpm", "install", "--frozen-lockfile", "--virtual-store-dir=/pnpm/vstore"])
  );
}

/**
 * The JS-family packages the Dagger gates test — the ONE list (#789). Each
 * function takes its `--filter` from here, and `jsWorkspace` builds every one
 * of them *with* its workspace dependencies (`<pkg>...`), in pnpm's graph order,
 * before any test runs:
 *
 *   - the dependencies, because their `exports` point into gitignored `dist/`:
 *     the gates only ever passed on the operator's uploaded `dist/`, and 9 of
 *     14 `prepushAll` functions were red from a clean tree;
 *   - the package itself, because suites read their OWN `dist/` — the
 *     bundle-size tests of sdk-deno / sdk-bun / sdk-react skip without it, and
 *     each `postbuild` runs that package's size budget. Building only the
 *     dependencies (`^...`) turned those into silent skips (#789 review).
 *
 * Packages with no `build` script are skipped. A per-function build would be a
 * different exec per function — never deduped — and a hand-written
 * `-F sdk-shared -F …` a second spelling of the graph.
 */
const JS_TESTED = {
  node: "@confeature/sdk-node",
  browserJs: "@confeature/sdk-browser-js",
  deno: "@confeature/sdk-deno",
  bun: "@confeature/sdk-bun",
  angular: "@confeature/sdk-angular",
  react: "@confeature/sdk-react",
  cloudflareWorker: "@confeature/sdk-cloudflare-worker",
  harness: "@confeature/test-harness-live-contract",
} as const;

/**
 * `nodeContainer` plus ONE build exec over `JS_TESTED`. Identical in
 * every caller, so Dagger runs it once per session. The trade-off, accepted: a
 * failed dependency build reddens every JS-family function, under whichever
 * name rejects first — the build step's own error names the package.
 */
function jsWorkspace(source: Directory, platform?: Platform): Container {
  return nodeContainer(source, platform).withExec([
    "pnpm",
    ...Object.values(JS_TESTED).flatMap((pkg) => ["--filter", `${pkg}...`]),
    "--if-present",
    "run",
    "build",
  ]);
}

/**
 * Build the shared Android-SDK container (JDK 17 + cmdline-tools + platform-34 +
 * build-tools), used by `androidTest`, and by `kotlinMpTest` through
 * `kotlinMpToolchain`. Both apply the Android
 * Gradle Plugin (kotlin-mp's `androidTarget` needs ANDROID_HOME even to
 * *configure* its `jvmTest` task), so neither can run on a bare JDK image.
 *
 * The ~1.5 GB SDK is mounted as a cache volume and the install is guarded by an
 * idempotent existence check, so only the first cold run pays the download. The
 * Gradle wrapper requires JDK 17+ (AGP 8.x); the project compiles to its own
 * target. License acceptance is non-interactive (`yes | sdkmanager --licenses`).
 */
function androidSdkContainer(source: Directory): Container {
  return androidSdkToolchain().withMountedDirectory("/work", source);
}

/** {@link androidSdkContainer} before the source is mounted, so a layer added on top stays cached. */
function androidSdkToolchain(): Container {
  const cmdlineTools =
    "https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip";
  // Pin to linux/amd64: AGP fetches `com.android.tools.build:aapt2:*:linux`, an
  // x86-64-only native binary (Google ships no linux-aarch64 aapt2). On the
  // operator's arm64 host the default arm64 container can't start the aapt2
  // daemon ("Daemon startup failed", #364). Forcing amd64 runs aapt2 under
  // emulation. Release-gate-only (localGate:false), so the emulation slowdown
  // never touches the local prepushAll budget.
  return dag
    .container({ platform: "linux/amd64" as Platform })
    .from("eclipse-temurin:17.0.20_8-jdk")
    .withEnvVariable("CI", "true")
    .withEnvVariable("ANDROID_HOME", "/opt/android-sdk")
    .withEnvVariable("ANDROID_SDK_ROOT", "/opt/android-sdk")
    .withEnvVariable("GRADLE_USER_HOME", "/cache/gradle")
    .withMountedCache("/cache/gradle", dag.cacheVolume("gradle-cache"))
    .withMountedCache("/opt/android-sdk", dag.cacheVolume("android-sdk-34"))
    .withExec([
      "bash",
      "-eu",
      "-c",
      // Newline-joined script (NOT `&&`-joined — the if/then/fi block would
      // break). `bash -eu` stops on any failed line.
      [
        "apt-get update >/dev/null",
        "apt-get install -y --no-install-recommends curl unzip ca-certificates >/dev/null",
        "rm -rf /var/lib/apt/lists/*",
        // Idempotent install: skip if the cached SDK volume already has it.
        'TOOLS="$ANDROID_HOME/cmdline-tools/latest/bin"',
        'if [ ! -x "$TOOLS/sdkmanager" ]; then',
        '  mkdir -p "$ANDROID_HOME/cmdline-tools"',
        `  curl -sLo /tmp/cmdtools.zip ${cmdlineTools}`,
        '  unzip -q /tmp/cmdtools.zip -d "$ANDROID_HOME/cmdline-tools"',
        '  mv "$ANDROID_HOME/cmdline-tools/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"',
        '  yes | "$TOOLS/sdkmanager" --licenses >/dev/null',
        `  "$TOOLS/sdkmanager" 'platform-tools' 'platforms;android-34' 'build-tools;34.0.0' >/dev/null`,
        "fi",
      ].join("\n"),
    ]);
}

/**
 * Chrome for Testing's headless shell, pinned by version and SHA-256: the browser
 * kotlin-mp's `jsBrowserTest` runs in (#928). Without it the gate skipped the
 * browser target. The zip carries `deb.deps`, Chrome's own list of the Debian
 * packages it needs; `apt-get satisfy` installs them under whatever names the
 * base image's release gives them (the t64 renames included), so the list is
 * never restated here. Karma finds the binary through `CHROME_BIN`.
 */
const CHROME_FOR_TESTING = {
  version: "156.0.8078.47",
  sha256: "0d5acc62c3e213f8c87d3c298d66ffcf9a236d12ea4b9f85318bf85dbc279daa",
};

/** kotlin-mp's toolchain: the Android SDK image plus the pinned headless Chrome. */
function kotlinMpToolchain(source: Directory): Container {
  const { version, sha256 } = CHROME_FOR_TESTING;
  const zip = `https://storage.googleapis.com/chrome-for-testing-public/${version}/linux64/chrome-headless-shell-linux64.zip`;
  return androidSdkToolchain()
    .withExec([
      "bash",
      "-eu",
      "-c",
      [
        `curl -sSfLo /tmp/chrome.zip ${zip}`,
        `echo "${sha256}  /tmp/chrome.zip" | sha256sum -c -`,
        "unzip -q /tmp/chrome.zip -d /opt",
        "rm /tmp/chrome.zip",
        "apt-get update >/dev/null",
        'apt-get satisfy -y --no-install-recommends "$(paste -sd, /opt/chrome-headless-shell-linux64/deb.deps)" >/dev/null',
        "rm -rf /var/lib/apt/lists/*",
      ].join("\n"),
    ])
    .withEnvVariable("CHROME_BIN", "/opt/chrome-headless-shell-linux64/chrome-headless-shell")
    .withMountedDirectory("/work", source);
}

/**
 * Each native SDK's toolchain, with the SDK's directory as working directory:
 * the one definition of it, shared by that SDK's test function and its live
 * suite (#793 FR-007, FR-015). Every image is an exact version tag (FR-008).
 */
function pythonToolchain(source: Directory): Container {
  return dag
    .container()
    .from("python:3.13.16-slim-bookworm")
    .withEnvVariable("CI", "true")
    .withEnvVariable("UV_INSTALL_VERSION", "0.4.30")
    .withExec([
      "bash",
      "-c",
      "apt-get update >/dev/null && apt-get install -y --no-install-recommends git ca-certificates curl >/dev/null && rm -rf /var/lib/apt/lists/*",
    ])
    .withMountedCache("/root/.cache/uv", dag.cacheVolume("uv-cache"))
    .withMountedCache("/root/.local/share/uv/python", dag.cacheVolume("uv-python"))
    .withExec([
      "bash",
      "-euo",
      "pipefail",
      "-c",
      // uv 0.4.x installs to $CARGO_HOME/bin (defaults to $HOME/.cargo/bin).
      // We pin install location via CARGO_HOME so the subsequent PATH update
      // resolves the binary deterministically across uv releases.
      //
      // `-euo pipefail` is load-bearing: without `pipefail`, a curl failure
      // (DNS / 502 / network outage) before any bytes hit stdout leaves
      // `sh` receiving empty input and exiting 0 — uv would be silently
      // absent and the subsequent `uv sync` would fail with the opaque
      // "uv: command not found" rather than surfacing the actual download
      // failure here.
      "CARGO_HOME=/root/.cargo curl -LsSf https://astral.sh/uv/${UV_INSTALL_VERSION}/install.sh | sh",
    ])
    .withEnvVariable(
      "PATH",
      "/root/.cargo/bin:/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    )
    .withMountedDirectory("/work", source)
    .withWorkdir("/work/apps/sdk-python");
}

function rubyToolchain(source: Directory): Container {
  return dag
    .container()
    .from("ruby:3.3.12-bookworm")
    .withEnvVariable("CI", "true")
    .withEnvVariable("BUNDLE_PATH", "/cache/bundle")
    .withMountedCache("/cache/bundle", dag.cacheVolume("bundle-cache"))
    .withMountedDirectory("/work", source)
    .withWorkdir("/work/apps/sdk-ruby");
}

function phpToolchain(source: Directory): Container {
  // composer binary copied from the official image (no curl-install needed).
  const composerBin = dag.container().from("composer:2.9.8").file("/usr/bin/composer");
  return (
    dag
      .container()
      .from("php:8.3.35-cli-bookworm")
      .withEnvVariable("CI", "true")
      .withEnvVariable("COMPOSER_CACHE_DIR", "/cache/composer")
      .withMountedCache("/cache/composer", dag.cacheVolume("composer-cache"))
      // git + unzip for composer; libonig/libxml/libzip for the
      // mbstring/dom/xml/zip extensions phpunit 10 requires; pcov (built via
      // $PHPIZE_DEPS) is the code-coverage driver — without it phpunit emits a
      // "No code coverage driver available" warning and exits 1 even though the
      // suite passes.
      .withExec([
        "bash",
        "-eu",
        "-c",
        'apt-get update >/dev/null && apt-get install -y --no-install-recommends git unzip libonig-dev libxml2-dev libzip-dev $PHPIZE_DEPS >/dev/null && docker-php-ext-install -j"$(nproc)" mbstring dom xml zip >/dev/null && pecl install pcov >/dev/null && docker-php-ext-enable pcov && rm -rf /var/lib/apt/lists/*',
      ])
      .withFile("/usr/local/bin/composer", composerBin)
      .withMountedDirectory("/work", source)
      .withWorkdir("/work/apps/sdk-php")
  );
}

function goToolchain(source: Directory): Container {
  return dag
    .container()
    .from("golang:1.23.12-bookworm")
    .withEnvVariable("CI", "true")
    .withEnvVariable("GOMODCACHE", "/cache/go-mod")
    .withEnvVariable("GOCACHE", "/cache/go-build")
    .withMountedCache("/cache/go-mod", dag.cacheVolume("go-mod-cache"))
    .withMountedCache("/cache/go-build", dag.cacheVolume("go-build-cache"))
    .withExec(["useradd", "-m", "-u", "1000", "runner"])
    .withExec([
      "bash",
      "-eu",
      "-c",
      // Install staticcheck under root with GOBIN forced to /usr/local/bin so
      // it resolves on PATH for the unprivileged runner user.
      "GOBIN=/usr/local/bin go install honnef.co/go/tools/cmd/staticcheck@2024.1.1",
    ])
    .withMountedDirectory("/work", source)
    .withWorkdir("/work/apps/sdk-go");
}

function rustToolchain(source: Directory): Container {
  return (
    dag
      .container()
      .from("rust:1.88.0-bookworm")
      .withEnvVariable("CI", "true")
      .withEnvVariable("CARGO_HOME", "/cache/cargo")
      // Target dir OUTSIDE /work so the cache mount never collides with the
      // mounted source directory (the EBUSY class of conflict).
      .withEnvVariable("CARGO_TARGET_DIR", "/cache/target")
      .withMountedCache("/cache/cargo", dag.cacheVolume("cargo-home"))
      .withMountedCache("/cache/target", dag.cacheVolume("cargo-target"))
      .withMountedDirectory("/work", source)
      .withWorkdir("/work/apps/sdk-rust")
  );
}

function javaToolchain(source: Directory): Container {
  return dag
    .container()
    .from("eclipse-temurin:21.0.11_10-jdk")
    .withEnvVariable("CI", "true")
    .withEnvVariable("GRADLE_USER_HOME", "/cache/gradle")
    .withMountedCache("/cache/gradle", dag.cacheVolume("gradle-cache"))
    .withMountedDirectory("/work", source)
    .withWorkdir("/work/apps/sdk-java");
}

function dotnetToolchain(source: Directory): Container {
  // The suite targets net8.0 and net10.0: the 8.0 runtime is copied in.
  const net8Runtime = dag
    .container()
    .from("mcr.microsoft.com/dotnet/runtime:8.0.32")
    .directory("/usr/share/dotnet/shared/Microsoft.NETCore.App");
  return dag
    .container()
    .from("mcr.microsoft.com/dotnet/sdk:10.0.400")
    .withDirectory("/usr/share/dotnet/shared/Microsoft.NETCore.App", net8Runtime)
    .withEnvVariable("CI", "true")
    .withEnvVariable("DOTNET_CLI_TELEMETRY_OPTOUT", "1")
    .withEnvVariable("DOTNET_NOLOGO", "1")
    .withEnvVariable("NUGET_PACKAGES", "/cache/nuget")
    .withMountedCache("/cache/nuget", dag.cacheVolume("nuget-cache"))
    .withMountedDirectory("/work", source)
    .withWorkdir("/work/apps/sdk-dotnet");
}

function dartToolchain(source: Directory): Container {
  return dag
    .container()
    .from("dart:3.11.6")
    .withEnvVariable("CI", "true")
    .withEnvVariable("PUB_CACHE", "/cache/pub")
    .withMountedCache("/cache/pub", dag.cacheVolume("pub-cache"))
    .withMountedDirectory("/work", source)
    .withWorkdir("/work/apps/sdk-dart");
}

function elixirToolchain(source: Directory): Container {
  return dag
    .container()
    .from("elixir:1.17.3-otp-27")
    .withEnvVariable("CI", "true")
    .withEnvVariable("MIX_ENV", "test")
    .withMountedCache("/work/apps/sdk-elixir/deps", dag.cacheVolume("mix-deps"))
    .withMountedCache("/work/apps/sdk-elixir/_build", dag.cacheVolume("mix-build"))
    .withMountedDirectory("/work", source)
    .withWorkdir("/work/apps/sdk-elixir");
}

function cppToolchain(source: Directory): Container {
  return (
    dag
      .container()
      .from("debian:12.13")
      .withEnvVariable("CI", "true")
      // FetchContent pulls nlohmann/json + Catch2 over the network at configure
      // time; cmake-built artefacts are cached under /cache/cpp-build.
      .withMountedCache("/cache/cpp-build", dag.cacheVolume("cpp-build"))
      .withExec([
        "bash",
        "-eu",
        "-c",
        // clang-tidy-19 / clang-format-19 (bookworm main, 19.1.7): one LLVM
        // major for both, the SDK's declared lint bar run by `cppTest` (#839).
        // python3 runs run-clang-tidy-19.
        "apt-get update >/dev/null && apt-get install -y --no-install-recommends g++ cmake make git ca-certificates libcurl4-openssl-dev libssl-dev clang-tidy-19 clang-format-19 python3 >/dev/null && rm -rf /var/lib/apt/lists/*",
      ])
      .withMountedDirectory("/work", source)
      .withWorkdir("/work/apps/sdk-cpp")
  );
}

/** Where `liveSuite` mounts the deployed harness: the path every `liveSuite.runner` names. */
const HARNESS_DIR = "/work/tools/test-harness-live-contract";

/**
 * The harness as a self-contained directory (#918, plan 867 A4): built in
 * `jsWorkspace`, then `pnpm deploy --prod`, which copies its runtime
 * dependencies (wrangler, zod) out of the store into its own `node_modules`.
 * Copying `jsWorkspace`'s `node_modules` instead would carry links into the
 * pnpm store, a cache volume that is not part of any container snapshot.
 * `inject-workspace-packages` is set for this one command only: pnpm 10+
 * deploys nothing else, and the harness has no workspace dependency to inject.
 * `platform` is the target container's when it differs from the engine's
 * (#922): the deploy carries native binaries (workerd, esbuild), which pnpm
 * picks for the platform it installs on.
 */
function deployedHarness(source: Directory, platform?: Platform): Directory {
  return jsWorkspace(source, platform)
    .withExec([
      "pnpm",
      "--config.inject-workspace-packages=true",
      "deploy",
      "--filter",
      JS_TESTED.harness,
      "--prod",
      "/harness-deploy",
    ])
    .directory("/harness-deploy");
}

/** How a live container is built: the builder, and whether it already carries Node and the harness. */
type LiveToolchain = { build: (source: Directory) => Container; node?: true };

/**
 * The recipes a Dagger live suite's container is built from, keyed by
 * toolchain id. Each recipe is an SDK builder, the one its `*Test` function
 * uses, so a live suite runs on exactly the toolchain its suite does.
 *
 * This is a recipe table, not an SDK list. An SDK reaches a recipe only
 * through its `liveSuite.toolchain` in dagger/sdk-manifest.json, the one SDK
 * list, never by its own name, and nothing enumerates these keys to find
 * SDKs. That 12 of the ids are spelled like the one SDK they serve is
 * naming, not a second list; `js` serves the whole JS family. An id with no
 * recipe is refused by liveContainer, never defaulted. `node: true` marks a
 * builder that already has the pinned Node runtime and a built harness
 * (`jsWorkspace`), and is set here only.
 */
const LIVE_TOOLCHAINS: Record<string, LiveToolchain> = {
  js: { build: jsWorkspace, node: true },
  python: { build: pythonToolchain },
  ruby: { build: rubyToolchain },
  php: { build: phpToolchain },
  go: { build: goToolchain },
  rust: { build: rustToolchain },
  java: { build: javaToolchain },
  android: { build: androidSdkContainer },
  "kotlin-mp": { build: kotlinMpToolchain },
  dotnet: { build: dotnetToolchain },
  dart: { build: dartToolchain },
  elixir: { build: elixirToolchain },
  cpp: { build: cppToolchain },
};

/**
 * A Node one-liner that runs the deployed harness's workerd binary (found the
 * way wrangler finds it) with `--version`, run from `HARNESS_DIR`: it exits 1
 * naming `platform` when that binary — or the Node runtime running the
 * one-liner — cannot execute in the toolchain container (#922).
 */
function nativeHarnessCheck(platform: Platform): string {
  return [
    "try {",
    '  const fromWrangler = require("module").createRequire(require.resolve("wrangler/package.json"));',
    '  const workerd = fromWrangler("workerd");',
    '  require("child_process").execFileSync(workerd.default ?? workerd, ["--version"], { stdio: "pipe" });',
    "} catch (error) {",
    `  console.error("the deployed harness's workerd does not run on ${platform}: " + (error.message || error));`,
    "  process.exit(1);",
    "}",
  ].join("\n");
}

/**
 * The container an SDK's live suite runs in, at the repository root: the
 * LIVE_TOOLCHAINS recipe its manifest `liveSuite.toolchain` names, read from
 * `source` (an SDK with no id, or an id with no recipe, is refused naming
 * both; `Object.hasOwn`, so no Object.prototype key passes), plus (outside the JS family) the pinned Node runtime copied from
 * `NODE_IMAGE`'s `/usr/local` — every toolchain image is glibc Debian or
 * Ubuntu — and the deployed harness mounted where the runner names it.
 *
 * Both are built for the TOOLCHAIN's platform, not the engine's (#922): the
 * Node binary, workerd and esbuild are native code, and a toolchain pinned to
 * another platform (`androidSdkContainer`, linux/amd64 for aapt2, #364) cannot
 * run the engine's. When the platforms match — every toolchain on CI, and all
 * but the pinned ones locally — the harness is the same `jsWorkspace` deploy
 * as before. The check step runs node and workerd once before the suite, so a
 * platform mismatch fails as one, not as a suite that cannot boot its harness.
 */
async function liveContainer(source: Directory, sdk: string): Promise<Container> {
  const { sdks } = JSON.parse(await source.file("dagger/sdk-manifest.json").contents()) as {
    sdks: Array<{ name: string; liveSuite?: { toolchain?: unknown } }>;
  };
  const id = sdks.find((s) => s.name === sdk)?.liveSuite?.toolchain;
  if (typeof id !== "string" || !Object.hasOwn(LIVE_TOOLCHAINS, id))
    throw new Error(
      `dagger/sdk-manifest.json: ${sdk}'s liveSuite.toolchain ${JSON.stringify(id ?? null)} is not a LIVE_TOOLCHAINS recipe of dagger/src/index.ts`,
    );
  const toolchain = LIVE_TOOLCHAINS[id];
  const base = toolchain.build(source);
  if (toolchain.node) return base.withWorkdir("/work");
  const platform = await base.platform();
  const foreign = platform === (await dag.defaultPlatform()) ? undefined : platform;
  return base
    .withDirectory(
      "/usr/local",
      dag.container({ platform }).from(NODE_IMAGE).directory("/usr/local"),
    )
    .withMountedDirectory(HARNESS_DIR, deployedHarness(source, foreign))
    .withWorkdir(HARNESS_DIR)
    .withExec(["node", "-e", nativeHarnessCheck(platform)])
    .withWorkdir("/work");
}

@object()
export class Confeature {
  /**
   * Run apps/sdk-node's vitest suite inside node:22.23.3-bookworm-slim.
   *
   * Behaviour preserved verbatim from Phase 2 — the suffix string still reads
   * "(Phase 2 jsTest)" to make the contract diff obvious during review.
   *
   * @param source The workspace root (a local caller goes through tools/dagger-call; CI passes `--source=.` on a fresh checkout).
   */
  @func()
  async jsTest(source: Directory): Promise<string> {
    const result = await jsWorkspace(source)
      .withExec(["pnpm", "--filter", JS_TESTED.node, "test", "run"])
      .stdout();
    const lastLine = result.trim().split("\n").slice(-1)[0];
    return `${lastLine} (Phase 2 jsTest)`;
  }

  /**
   * Run `packages/sdk-shared`'s vitest suite — the reference evaluation engine
   * AND the ConfigCat conformance corpus (`parity-upstream.test.ts`, which
   * replays the vendored upstream matrix from `@confeature/test-fixtures-sdk-parity`).
   * This is the gate that keeps the decision engine at ConfigCat parity locally
   * (spec 117 / epic #382, Principle VII — the ~1300-case corpus runs in the
   * local pre-push pipeline, never per-PR CI). Shares the JS-family install layer.
   *
   * @param source The workspace root (a local caller goes through tools/dagger-call; CI passes `--source=.` on a fresh checkout).
   */
  @func()
  async sharedTest(source: Directory): Promise<string> {
    const result = await nodeContainer(source)
      .withExec(["pnpm", "--filter", "@confeature/sdk-shared", "test", "run"])
      .stdout();
    const lastLine = result.trim().split("\n").slice(-1)[0];
    return `${lastLine} (sharedTest #382 — eval-engine conformance corpus)`;
  }

  /**
   * Run apps/sdk-browser-js's vitest suite inside the shared node container.
   *
   * Reuses `jsWorkspace(source)` — no new image, no new cache volume.
   *
   * @param source The workspace root.
   */
  @func()
  async browserTest(source: Directory): Promise<string> {
    const result = await jsWorkspace(source)
      .withExec(["pnpm", "--filter", JS_TESTED.browserJs, "test", "run"])
      .stdout();
    const lastLine = result.trim().split("\n").slice(-1)[0];
    return `${lastLine} (Phase 3 browserTest)`;
  }

  // Tier-1 SDK gates (#355, epic #354). The five JS-family wrappers
  // (deno, bun, angular, react, cloudflare-worker) all test via vitest on
  // Node — deno/bun use `@types/*` for typing but run their suites under the
  // default vitest Node pool, angular under jsdom + @analogjs/vitest-angular,
  // cloudflare-worker against an in-memory KVNamespace mock (NOT workerd).
  // So each reuses the shared `jsWorkspace(source)` exactly like
  // `browserTest` — no new image, no native runtime, no new cache volume.
  // Flipping each SDK's manifest entry to `covered` (with the kebab name
  // below) enrols it in `release-gate.yml` + `sdk-publish.yml`; adding it to
  // `prepushAll` enrols it in the local gate (Principle VII v1.3.0 — the
  // canonical suite tracks the manifest's covered set).

  /** Run apps/sdk-deno's vitest suite inside the shared node container. */
  @func()
  async denoTest(source: Directory): Promise<string> {
    const result = await jsWorkspace(source)
      .withExec(["pnpm", "--filter", JS_TESTED.deno, "test", "run"])
      .stdout();
    const lastLine = result.trim().split("\n").slice(-1)[0];
    return `${lastLine} (Tier 1 denoTest)`;
  }

  /** Run apps/sdk-bun's vitest suite inside the shared node container. */
  @func()
  async bunTest(source: Directory): Promise<string> {
    const result = await jsWorkspace(source)
      .withExec(["pnpm", "--filter", JS_TESTED.bun, "test", "run"])
      .stdout();
    const lastLine = result.trim().split("\n").slice(-1)[0];
    return `${lastLine} (Tier 1 bunTest)`;
  }

  /** Run apps/sdk-angular's vitest suite (jsdom + @analogjs/vitest-angular). */
  @func()
  async angularTest(source: Directory): Promise<string> {
    const result = await jsWorkspace(source)
      .withExec(["pnpm", "--filter", JS_TESTED.angular, "test", "run"])
      .stdout();
    const lastLine = result.trim().split("\n").slice(-1)[0];
    return `${lastLine} (Tier 1 angularTest)`;
  }

  /** Run apps/sdk-react's vitest suite inside the shared node container. */
  @func()
  async reactTest(source: Directory): Promise<string> {
    const result = await jsWorkspace(source)
      .withExec(["pnpm", "--filter", JS_TESTED.react, "test", "run"])
      .stdout();
    const lastLine = result.trim().split("\n").slice(-1)[0];
    return `${lastLine} (Tier 1 reactTest)`;
  }

  /** Run apps/sdk-cloudflare-worker's vitest suite (in-memory KV mock, not workerd). */
  @func()
  async cloudflareWorkerTest(source: Directory): Promise<string> {
    const result = await jsWorkspace(source)
      .withExec(["pnpm", "--filter", JS_TESTED.cloudflareWorker, "test", "run"])
      .stdout();
    const lastLine = result.trim().split("\n").slice(-1)[0];
    return `${lastLine} (Tier 1 cloudflareWorkerTest)`;
  }

  // Tier-2 SDK gates (#356, epic #354). Standard-toolchain SDKs — unlike
  // Tier 1, each needs its OWN base image + toolchain (JDK/Gradle, .NET SDK,
  // PHP+composer, Ruby+bundler, cargo, Dart), so each mirrors the goTest /
  // pythonTest custom-container pattern with its own cache volume(s) rather
  // than the shared nodeContainer. Each runs that SDK's canonical lint+test
  // chain; the manifest marks them covered (release-gate + sdk-publish).
  //
  // DELIBERATELY NOT added to prepushAll: 6 heavyweight heterogeneous
  // toolchain containers running in parallel exceed the NFR-004 8 GB local
  // budget and OOM-kill the Dagger engine (verified during #356). They are
  // `localGate: false` in sdk-manifest.json — release-gate-only — per the
  // constitution v1.3.0 "demote the slowest tier to release-gate-only"
  // clause. In release-gate.yml each runs on its own CI runner, so there is
  // no shared-memory OOM. (Re-home them locally only with a concurrency
  // limiter that respects the 8 GB / 5-min budget.)

  /**
   * Run apps/sdk-java's Gradle `check` (spotless + test + jacoco).
   *
   * Runs on JDK 21 — modern Gradle requires JVM 17+ to *execute* even though
   * the project compiles to a Java 11 bytecode target (sourceCompatibility 11).
   */
  @func()
  async javaTest(source: Directory): Promise<string> {
    // `sh ./gradlew` runs the wrapper regardless of the file's exec bit;
    // `--no-daemon` is mandatory in ephemeral containers (no reuse). `check`
    // is the SDK's declared bar: tests, Spotless, JaCoCo verify.
    const result = await javaToolchain(source)
      .withExec(["sh", "-eu", "-c", "sh ./gradlew --no-daemon check"])
      .stdout();
    const lastLine = result.trim().split("\n").slice(-1)[0];
    return `${lastLine} (Tier 2 javaTest)`;
  }

  /**
   * Run apps/sdk-java's Gradle `spotlessApply` and return the formatted
   * sdk-java directory so the host can re-export the canonically-formatted
   * sources. Use when `javaTest`'s spotlessCheck fails and there is no local
   * JDK to run the formatter: `dagger call java-format --source=. export
   * --path=apps/sdk-java`.
   */
  @func()
  javaFormat(source: Directory): Directory {
    return dag
      .container()
      .from("eclipse-temurin:21-jdk")
      .withEnvVariable("CI", "true")
      .withEnvVariable("GRADLE_USER_HOME", "/cache/gradle")
      .withMountedCache("/cache/gradle", dag.cacheVolume("gradle-cache"))
      .withMountedDirectory("/work", source)
      .withWorkdir("/work/apps/sdk-java")
      .withExec(["sh", "-eu", "-c", "sh ./gradlew --no-daemon spotlessApply"])
      .directory("/work/apps/sdk-java");
  }

  /**
   * Run apps/sdk-dotnet's `dotnet test` on the .NET 10 SDK. The test project
   * targets net8.0;net10.0 and runs the suite on each, but the sdk:10.0 image
   * ships only the .NET 10 runtime — so the .NET 8 shared runtime is copied in
   * from the official runtime image, else the net8.0 testhost cannot start.
   */
  @func()
  async dotnetTest(source: Directory): Promise<string> {
    // TreatWarningsAsErrors (Directory.Build.props) makes the build the
    // analyzer bar; `dotnet format --verify-no-changes` holds the formatting
    // (#793 FR-007, #915: no drift is hidden by an unchecked format step).
    const result = await dotnetToolchain(source)
      .withExec([
        "bash",
        "-eu",
        "-c",
        "dotnet format --verify-no-changes && dotnet test --configuration Release",
      ])
      .stdout();
    const lastLine = result.trim().split("\n").slice(-1)[0];
    return `${lastLine} (Tier 2 dotnetTest)`;
  }

  /** Run apps/sdk-php's composer `test` (phpunit) on PHP 8.3 + composer. */
  @func()
  async phpTest(source: Directory): Promise<string> {
    // `composer lint` (php-cs-fixer, dry run) is the SDK's own merge bar:
    // zero offenses (#793 FR-007).
    const result = await phpToolchain(source)
      .withExec([
        "bash",
        "-eu",
        "-c",
        "composer install --no-interaction --no-progress && composer test && composer lint",
      ])
      .stdout();
    const lastLine = result.trim().split("\n").slice(-1)[0];
    return `${lastLine} (Tier 2 phpTest)`;
  }

  /** Run apps/sdk-ruby's `rake` default (rubocop + rspec) on Ruby 3.3. */
  @func()
  async rubyTest(source: Directory): Promise<string> {
    // The Rakefile's default task is rubocop + spec: the SDK's merge bar.
    const result = await rubyToolchain(source)
      .withExec(["bash", "-eu", "-c", "bundle install && bundle exec rake"])
      .stdout();
    const lastLine = result.trim().split("\n").slice(-1)[0];
    return `${lastLine} (Tier 2 rubyTest)`;
  }

  /**
   * Run apps/sdk-rust's MSRV guard + format check + tests (#363).
   *
   * Two rustc floors, because the dev-deps need a higher one than the library:
   *  - LIBRARY MSRV = 1.86 — what a consumer needs; what Cargo.toml advertises.
   *    The locked NON-dev tree needs ≥1.86 (icu_* 2.2, idna_adapter 1.2.2,
   *    base16ct 0.3 edition2024). `cargo +1.86 build --lib` is the guard: it
   *    compiles only the lib target (no dev-deps), so a green run proves the
   *    advertised MSRV genuinely builds.
   *  - TEST floor = 1.88 (the image default) — the `wiremock` 0.6.5 dev-dep uses
   *    let-chains (stabilised in 1.88), so `cargo test` needs ≥1.88.
   * If Cargo.toml's `rust-version` changes, bump the `+1.86` toolchain below in
   * lockstep; if a dev-dep raises the test floor, bump the `rust:1.88` image.
   */
  @func()
  async rustTest(source: Directory): Promise<string> {
    // MSRV guard (cargo +1.86 build --lib, no dev-deps), then fmt, clippy
    // with -D warnings (the SDK's declared merge bar, #793 FR-007) and the
    // tests on the image's 1.88 default.
    // rustfmt and clippy adds are idempotent.
    const result = await rustToolchain(source)
      .withExec([
        "bash",
        "-eu",
        "-c",
        "rustup toolchain install 1.86 --profile minimal && cargo +1.86 build --lib && rustup component add rustfmt clippy && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test",
      ])
      .stdout();
    const lastLine = result.trim().split("\n").slice(-1)[0];
    return `${lastLine} (Tier 2 rustTest)`;
  }

  /** Run apps/sdk-dart's `dart analyze && dart test` on the stable Dart SDK. */
  @func()
  async dartTest(source: Directory): Promise<string> {
    // `dart analyze --fatal-infos` is the SDK's declared bar; `dart format`
    // holds the formatting.
    const result = await dartToolchain(source)
      .withExec([
        "bash",
        "-eu",
        "-c",
        "dart pub get && dart format --output=none --set-exit-if-changed . && dart analyze --fatal-infos && dart test",
      ])
      .stdout();
    const lastLine = result.trim().split("\n").slice(-1)[0];
    return `${lastLine} (Tier 2 dartTest)`;
  }

  // Tier-3 SDK gates (#357, epic #354). Heaviest toolchains. Like Tier 2 these
  // are `localGate: false` (release-gate-only) — too heavy for the local 8 GB
  // budget. elixir + cpp have self-contained containers and ARE covered.
  //
  // android + kotlin-mp share `androidSdkContainer()` (both apply the Android
  // Gradle Plugin — kotlin-mp's androidTarget needs ANDROID_HOME even to
  // configure jvmTest). RESOLVED in #364 (spec 114): the earlier "AAPT2 Daemon
  // startup failed" wall was an arch mismatch — AGP fetches an x86-64-only
  // `aapt2` (Google ships no linux-aarch64 build), which can't start on an
  // arm64 container. `androidSdkContainer` is now pinned to `linux/amd64` so
  // aapt2 runs under emulation. Both are `covered` (localGate:false,
  // release-gate-only — the emulated run is too slow for the local budget).

  /** Run apps/sdk-elixir's `mix test` on Elixir 1.17 / OTP 27. */
  @func()
  async elixirTest(source: Directory): Promise<string> {
    const result = await elixirToolchain(source)
      .withExec([
        "bash",
        "-eu",
        "-c",
        // `mix credo --strict` is the SDK's declared bar; `mix format` holds
        // the formatting. The prod compile is what a customer's `mix deps.compile`
        // does: the suite alone ran under MIX_ENV=test, where a test-only
        // transitive dependency (TypedStruct) hid a missing one (#805).
        "mix local.hex --force && mix local.rebar --force && mix deps.get && mix format --check-formatted && mix credo --strict && mix test && MIX_ENV=prod mix compile --warnings-as-errors",
      ])
      .stdout();
    const lastLine = result.trim().split("\n").slice(-1)[0];
    return `${lastLine} (Tier 3 elixirTest)`;
  }

  /**
   * Build apps/sdk-cpp (C++17, libcurl + OpenSSL 3, FetchContent), lint it,
   * then run its Catch2 suite.
   *
   * The lint is the SDK's declared bar, its own `.clang-tidy` and
   * `.clang-format` (#839): clang-tidy over every src/ and tests/ translation unit in the
   * exported compile_commands.json (headers through `.clang-tidy`'s
   * HeaderFilterRegex), with `--warnings-as-errors='*'` because the config's
   * `WarningsAsErrors` is empty and a warning alone exits 0; then
   * `clang-format --dry-run --Werror` over every .h/.cpp under include/, src/
   * and tests/ (the source view holds tracked files only). The file list is
   * refused when empty: clang-format given no file reads stdin and passes.
   */
  @func()
  async cppTest(source: Directory): Promise<string> {
    const result = await cppToolchain(source)
      .withExec([
        "bash",
        "-euo",
        "pipefail",
        "-c",
        [
          "cmake -S . -B /cache/cpp-build -DCONFEATURE_ENABLE_TESTS=ON",
          "cmake --build /cache/cpp-build",
          "run-clang-tidy-19 -clang-tidy-binary clang-tidy-19 -p /cache/cpp-build -quiet -warnings-as-errors='*' '/sdk-cpp/(src|tests)/'",
          "files=$(find include src tests -name '*.h' -o -name '*.cpp')",
          'test -n "$files"',
          "clang-format-19 --dry-run --Werror $files",
          "ctest --test-dir /cache/cpp-build --output-on-failure",
        ].join(" && "),
      ])
      .stdout();
    const lastLine = result.trim().split("\n").slice(-1)[0];
    return `${lastLine} (Tier 3 cppTest)`;
  }

  /** Run apps/sdk-android's `testDebugUnitTest` on JDK 17 + Android SDK 34. */
  @func()
  async androidTest(source: Directory): Promise<string> {
    const result = await androidSdkContainer(source)
      .withWorkdir("/work/apps/sdk-android")
      // The SDK's declared bar (#793 FR-007): Android Lint, the unit tests,
      // the release AAR build.
      .withExec(["sh", "-eu", "-c", "sh ./gradlew --no-daemon lint test assembleRelease"])
      .stdout();
    const lastLine = result.trim().split("\n").slice(-1)[0];
    return `${lastLine} (Tier 3 androidTest)`;
  }

  /** Run apps/sdk-kotlin-mp's `check`, its browser target included (#928). */
  @func()
  async kotlinMpTest(source: Directory): Promise<string> {
    const result = await kotlinMpToolchain(source)
      .withWorkdir("/work/apps/sdk-kotlin-mp")
      .withExec(["sh", "-eu", "-c", "sh ./gradlew --no-daemon check"])
      .stdout();
    const lastLine = result.trim().split("\n").slice(-1)[0];
    return `${lastLine} (Tier 3 kotlinMpTest)`;
  }

  /**
   * Run apps/sdk-python's full `python:ready` chain inside python:3.13-bookworm-slim.
   *
   * Chain: `uv sync --frozen --extra dev && uv run ruff check && uv run ruff format
   * --check && uv run mypy --strict src && uv run pytest && uv run pytest -m slow
   * && uv build`. The `[dev]` extra pulls `configcat-client>=10.0,<11.0` for the
   * API-surface conformance test (constitution Principle II); that test runs
   * transitively under `uv run pytest`.
   *
   * uv install: pinned to a specific 0.4.x release via UV_INSTALL_VERSION. We use
   * the official install script (R11). Switching to the `astral/uv:*` base image
   * is left as a follow-on (research R11 alternatives).
   *
   * @param source The workspace root. Workdir is /work/apps/sdk-python.
   */
  @func()
  async pythonTest(source: Directory): Promise<string> {
    const result = await pythonToolchain(source)
      .withExec([
        "bash",
        "-eu",
        "-c",
        "uv sync --frozen --extra dev && uv run ruff check && uv run ruff format --check && uv run mypy --strict src && uv run pytest && uv run pytest -m slow && uv build",
      ])
      .stdout();
    const lastLine = result.trim().split("\n").slice(-1)[0];
    return `${lastLine} (Phase 3 pythonTest)`;
  }

  /**
   * Run apps/sdk-go's full `go:ready` chain inside golang:1.23-bookworm.
   *
   * Chain: `gofmt -l . | wc -l == 0 && go vet ./... && staticcheck ./... &&
   * go test -cover ./... && go build ./...`. Module-declared Go version
   * (apps/sdk-go/go.mod) is 1.23 — that's the source of truth, NOT ci.yml's
   * 1.22 pin (skew tracked for Phase 4 / #203 per research R12).
   *
   * staticcheck is pinned to 2024.1.1 — NOT @latest (Principle VII cost
   * discipline says toolchains are pinned, not floating).
   *
   * @param source The workspace root. Workdir is /work/apps/sdk-go.
   */
  @func()
  async goTest(source: Directory): Promise<string> {
    // Run `go test` under a non-root user (`runner`, UID 1000). Reason:
    // sdk-go's TestFileCache_FallbackOnUnwritableDir depends on POSIX DAC
    // semantics — UID 0 bypasses chmod 0o555 read-only restrictions, so
    // the test never triggers its "WARNING on unwritable dir" path when
    // running as root inside the container. Running as non-root also
    // reproduces the host workflow (operator runs as a normal user).
    //
    // Cache volume NAMES (`go-mod-cache`, `go-build-cache`) are preserved
    // verbatim per contract pre-push-hook.md. The MOUNT PATHS shift one
    // hop (from /go/pkg/mod + /root/.cache/go-build to /cache/go-mod +
    // /cache/go-build) so the runner user can write to them; GOMODCACHE
    // + GOCACHE env vars redirect Go's toolchain accordingly.
    // `staticcheck` is installed under root (GOBIN=/usr/local/bin) so it
    // resolves on PATH for the unprivileged runner user.
    const result = await goToolchain(source)
      .withExec([
        "bash",
        "-eu",
        "-c",
        // The chown runs in THIS exec, not the install one: that layer is
        // cached, so a chown there is skipped while the cache volumes keep
        // changing underneath it — and the runner then cannot write to
        // /cache/go-build ("permission denied"). Here it runs every time.
        "chown -R runner:runner /cache && runuser -u runner -- bash -eu -c " +
          `'test -z "$(gofmt -l .)" && go vet ./... && staticcheck ./... && go test -cover ./... && go build ./...'`,
      ])
      .stdout();
    const lastLine = result.trim().split("\n").slice(-1)[0];
    return `${lastLine} (Phase 3 goTest)`;
  }

  /**
   * Run the wire-protocol corpus consumers in sdk-node + sdk-browser-js.
   *
   * Both consumers reference `packages/test-fixtures-sdk-parity/fixtures/wire-cases.json`
   * via vitest discovery in their respective `tests/wire/` directories. The
   * positional `tests/wire` filter restricts vitest to those subtrees only
   * (research R13). Python's `tests/wire/` is picked up transitively by
   * `pythonTest`'s `uv run pytest` — there is NO Python-specific wireCases step.
   *
   * @param source The workspace root.
   */
  @func()
  async wireCases(source: Directory): Promise<string> {
    const result = await jsWorkspace(source)
      .withExec([
        "pnpm",
        "--filter",
        JS_TESTED.node,
        "--filter",
        JS_TESTED.browserJs,
        "test",
        "run",
        "--",
        "tests/wire",
      ])
      .stdout();
    const lastLine = result.trim().split("\n").slice(-1)[0];
    return `${lastLine} (Phase 3 wireCases)`;
  }

  /**
   * Run one SDK's live wire-cases against the harness (#918, FR-015): the CLI's
   * `live-suite --sdk <name>`, a step of that SDK's leg in sdk-gates.yml.
   *
   * The container is liveContainer's, at the repository root; what runs in it
   * is tools/repo-gates/run-live-suite.mjs, the one implementation that finds
   * an SDK's `liveSuite.runner` and runs it, the same script the macOS job
   * runs natively. So the SDK name, the runner and how bash is handed it are
   * judged there, by manifestProblems, never here: `sdk` reaches no path,
   * cache-volume name or argv in this module, only liveContainer's manifest
   * lookup, the script's `SDK` and the messages.
   * The runner's harness wrapper (`--corpus-seed --exec`) boots the reference
   * origin through wrangler `unstable_dev` (in-process workerd, loopback
   * only, so the loopback-guarded admin routes stay unreachable from the
   * network) and hands the suite `CONFEATURE_LIVE=1` + `LIVE_HARNESS_URL`.
   * One container, not a service binding: the harness binds 127.0.0.1 by
   * design.
   *
   * The exec is the default `withExec`, so the script's exit code is the
   * call's: its exit 2 on a refused runner, or the suite's own failure, fails
   * the call and reddens the leg. Nothing here may soften that.
   *
   * @param source The workspace root.
   * @param sdk A manifest SDK name with a `liveSuite.runner`.
   */
  @func()
  async liveSuite(source: Directory, sdk: string): Promise<string> {
    const container = await liveContainer(source, sdk);
    const result = await container
      .withEnvVariable("SDK", sdk)
      .withExec(["node", "tools/repo-gates/run-live-suite.mjs"])
      .stdout();
    const lastLine = result.trim().split("\n").slice(-1)[0];
    return `${lastLine} (liveSuite ${sdk} #918)`;
  }

  /**
   * The harness package's own live self-test (`test:live`, #343), its home
   * since `liveContract` was folded into `liveSuite` (#918, plan 867 A8).
   *
   * @param source The workspace root.
   */
  @func()
  async harnessLiveTest(source: Directory): Promise<string> {
    const result = await jsWorkspace(source)
      .withExec(["pnpm", "--filter", JS_TESTED.harness, "test:live"])
      .stdout();
    const lastLine = result.trim().split("\n").slice(-1)[0];
    return `${lastLine} (harnessLiveTest #918)`;
  }

  /**
   * Run the native Deno CLI's quality gate (`apps/cli`) inside the official
   * `denoland/deno` container — the FIRST real Deno-runtime gate in the repo
   * (spec 179, FR-010 / Principle VII). NOT built on `nodeContainer`: the CLI
   * is a native `deno.json` project outside the pnpm workspace, so it needs the
   * Deno toolchain, not node + pnpm.
   *
   * Runs `deno fmt --check`, `deno lint`, then `deno test -A` against
   * `apps/cli`. The Deno module cache is mounted at `/deno-dir` (the default
   * `DENO_DIR`) so std-lib (`jsr:@std/*`) downloads are cached across runs.
   * Pinned to a concrete patch tag (`denoland/deno:2.8.3`, multi-arch incl.
   * arm64): Deno publishes NO floating `<major>` tag — only version-pinned
   * `2.8.x` / `alpine-2.8.x` / … — so the original `:2` pin could never
   * resolve the image (#655 review). A specific tag is the reproducible
   * fallback the image-pin policy (research R18) intends; bump on a Deno
   * upgrade.
   *
   * Gated locally via `prepushAll` only — deliberately kept OFF the hosted CI
   * matrix and out of `ready:deploy` (the CLI is not a deployed Worker).
   *
   * @param source The workspace root. Workdir is /work/apps/cli.
   */
  @func()
  async cliTest(source: Directory): Promise<string> {
    const result = await dag
      .container()
      .from("denoland/deno:2.8.3")
      .withEnvVariable("CI", "true")
      .withEnvVariable("DENO_DIR", "/deno-dir")
      .withMountedCache("/deno-dir", dag.cacheVolume("deno-cli-cache"))
      .withMountedDirectory("/work", source)
      .withWorkdir("/work/apps/cli")
      .withExec(["bash", "-eu", "-c", "deno fmt --check && deno lint && deno test -A"])
      .stdout();
    const lastLine = result.trim().split("\n").slice(-1)[0];
    return `${lastLine} (cliTest #653)`;
  }

  /**
   * Orchestrator — fan out the 5 functions in parallel via `Promise.all` and
   * enforce the SC-001 aggregate wall-clock budget (≤ BUDGET_MS / 5 min).
   *
   * Per research R14, the Dagger TS SDK's `dag.container()` calls are lazy —
   * Dagger Engine schedules the underlying container builds on its parallel
   * build queue when the 5 awaits are wrapped in `Promise.all`. Fail-fast
   * semantics: any single rejection causes `Promise.all` to reject; Dagger
   * cancels orphan containers on session exit.
   *
   * The SC-001 throw is the in-module (layer 1) defence-in-depth half of the
   * R15 contract; the `timeout 360s` wrapper in `pnpm dagger:all` is layer 2.
   *
   * The error message wording is fixed by `contracts/pre-push-hook.md` §"Failure
   * modes — operator-facing messages" and IS the string T017's fault-injection
   * test will grep for. Do not reword without updating that contract.
   *
   * @param source The workspace root.
   * @returns Multi-line string concatenating each function's last-line + final
   *          `[prepushAll] OK in <N>ms` marker on green.
   */
  @func()
  async prepushAll(source: Directory): Promise<string> {
    const started = performance.now();
    // Wrap each entry with a name-preserving `.catch()` so the contract's
    // "name the failing function" requirement (contracts/pre-push-hook.md
    // line 106, e.g. `pythonTest failed: ...`) is code-guaranteed rather
    // than Dagger Engine internals-dependent. T018 confirmed the engine
    // currently surfaces the function name in GraphQL error wrapping, but
    // a future engine version could change that — this catch makes the
    // wording immune to engine drift.
    // Each function's own wall-clock, so an overrun names what dominates
    // instead of a bare total (#789: the budget is judged per function).
    const timings: Array<[string, number]> = [];
    const wrapWithName = (name: string, p: Promise<string>): Promise<string> =>
      p
        .then((line) => {
          timings.push([name, Math.round(performance.now() - started)]);
          return line;
        })
        .catch((e: unknown) => {
          const msg = e instanceof Error ? e.message : String(e);
          throw new Error(`${name} failed: ${msg}`);
        });
    const timingReport = (): string =>
      [...timings]
        .sort((a, b) => b[1] - a[1])
        .map(([name, ms]) => `${name}=${ms}ms`)
        .join(" ");
    const [
      jsLine,
      browserLine,
      pythonLine,
      goLine,
      wireLine,
      denoLine,
      bunLine,
      angularLine,
      reactLine,
      cloudflareWorkerLine,
      sharedLine,
      cliLine,
    ] = await Promise.all([
      wrapWithName("jsTest", this.jsTest(source)),
      wrapWithName("browserTest", this.browserTest(source)),
      wrapWithName("pythonTest", this.pythonTest(source)),
      wrapWithName("goTest", this.goTest(source)),
      wrapWithName("wireCases", this.wireCases(source)),
      // Tier-1 (#355): JS-family wrappers, all vitest-on-Node in the shared container.
      wrapWithName("denoTest", this.denoTest(source)),
      wrapWithName("bunTest", this.bunTest(source)),
      wrapWithName("angularTest", this.angularTest(source)),
      wrapWithName("reactTest", this.reactTest(source)),
      wrapWithName("cloudflareWorkerTest", this.cloudflareWorkerTest(source)),
      // Eval-engine conformance corpus (#382): sdk-shared replays the vendored
      // ConfigCat matrix; shares the JS-family install layer.
      wrapWithName("sharedTest", this.sharedTest(source)),
      // Native Deno CLI gate (#653): the first Deno-runtime gate — fmt/lint/test
      // in the official denoland/deno container, not the shared nodeContainer.
      wrapWithName("cliTest", this.cliTest(source)),
    ]);
    const elapsed = Math.round(performance.now() - started);
    if (elapsed > BUDGET_MS) {
      throw new Error(
        `[prepushAll] SC-001 budget exceeded: ${elapsed}ms > ${BUDGET_MS}ms. Aggregate wall-clock budget enforced per constitution Principle VII. Finished at: ${timingReport()}`,
      );
    }
    return [
      jsLine,
      browserLine,
      pythonLine,
      goLine,
      wireLine,
      denoLine,
      bunLine,
      angularLine,
      reactLine,
      cloudflareWorkerLine,
      sharedLine,
      cliLine,
      `[prepushAll] finished at: ${timingReport()}`,
      `[prepushAll] OK in ${elapsed}ms`,
    ].join("\n");
  }
}
