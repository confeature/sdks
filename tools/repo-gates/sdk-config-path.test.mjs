// SPDX-License-Identifier: MIT

/**
 * A static check over every SDK, including the two whose suites run on macOS
 * or need an engine (Swift, Unreal): no tracked `apps/sdk-*` source file, tests
 * excluded, builds the `/v2/configuration-files` path or puts a cache-key tail
 * in a config URL. Confeature's CDN serves only
 * `/configuration-files/<sdkKey>/config_v6.json`: the route is the contract,
 * and the SDKs follow it, never the reverse. And every SDK that builds its own
 * URL must show the scan a CODE line holding both `configuration-files` and
 * `config_v6.json`, so a builder the rule cannot see fails instead of passing.
 *
 * Ported from the private monorepo (confeature-monorepo #795, where it ran in
 * the CDN's suite until the SDK copies there were removed). The files are read
 * here, in Node, from `git ls-files`: "tracked" is git's answer, not a glob's.
 * Fails closed: an empty listing throws rather than scan nothing.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

/** Which lines of an SDK source reach the line rule. The rule's own test pins it. */
function isCandidateLine(lineText) {
  return lineText.includes("configuration-files") || /v2/i.test(lineText);
}

/**
 * Every tracked `apps/sdk-*` and `packages/sdk-shared` path, the candidate
 * lines of those files, and whole only the files that name the path.
 */
function readSdkSources() {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = execFileSync("git", ["-C", here, "rev-parse", "--show-toplevel"], {
    encoding: "utf-8",
  }).trim();
  const trackedFiles = execFileSync(
    "git",
    ["-C", repoRoot, "ls-files", "-z", "--", "apps/sdk-*", "packages/sdk-shared"],
    { encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 },
  )
    .split("\0")
    .filter((path) => path.length > 0);
  if (trackedFiles.length === 0) {
    throw new Error(
      "sdk-config-path: git lists no tracked apps/sdk-* file — refusing to scan nothing",
    );
  }
  const configPathLines = [];
  const configPathFiles = [];
  for (const path of trackedFiles) {
    let text;
    try {
      text = readFileSync(join(repoRoot, path), "utf-8");
    } catch (error) {
      // A tracked file deleted in the working tree has nothing to scan; any
      // other read error is a broken checkout and must not pass silently.
      if (error.code === "ENOENT") continue;
      throw error;
    }
    const namesPath = text.includes("configuration-files");
    if (!namesPath && !isCandidateLine(text)) continue;
    if (namesPath) configPathFiles.push({ path, text });
    text.split("\n").forEach((lineText, index) => {
      if (isCandidateLine(lineText))
        configPathLines.push({ path, line: index + 1, text: lineText });
    });
  }
  return { trackedFiles, configPathLines, configPathFiles };
}

/** Source files, by extension — every language the federation ships in. */
const SOURCE_FILE =
  /\.(?:ts|tsx|mts|cts|js|mjs|cjs|kt|kts|java|cs|php|rb|rs|dart|swift|ex|exs|c|cc|cpp|cxx|h|hpp|inl|m|mm|go|py)$/;

/**
 * Test files: a `test`/`tests`/`spec` directory or one ending in `Test`/`Tests`
 * (jvmTest, ConfeatureTests, Private/Tests), or a test file-name convention.
 * Rust's in-file `#[cfg(test)]` modules are NOT excluded — a pin of the old
 * path there flips with the URL anyway (FR-004).
 */
const TEST_FILE =
  /(?:^|\/)(?:tests?|specs?|__tests__|[A-Za-z]*Tests?)\/|_test\.[a-z]+$|\.(?:test|spec)\.[a-z]+$|_spec\.rb$|(?:^|\/)test_[^/]*\.py$/;

/**
 * A `v2` path piece, any case: `…/v2/…` interpolated or in a format string,
 * `/v2` closing a literal, or `"v2"`, `"/v2"`, `"v2/"` as a literal of its own.
 */
const V2_PATH = /\/v2(?:\/|["'`])|["'`]\/?v2\/?["'`]|["'`]v2\//i;

/** A whole line of comment: `//`, `/*`, ` *`, `#` (not Ruby's `#{`), `--`, `%`. */
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*|#(?!\{)|--|%)/;

/** A comment after code: ` // …` (not `://`) or ` # …` (not Ruby's `#{`). */
const TRAILING_COMMENT = /\s(?:\/\/|#(?!\{)).*$/;

/**
 * The code on a line: nothing for a comment line, no trailing comment, and no
 * markdown code spans (``rst`` and `md`), which are how docstrings quote a URL
 * — except in a JS template literal (`${`), where the backticks ARE the code.
 */
function codeOf(lineText) {
  if (COMMENT_LINE.test(lineText)) return "";
  const noRst = lineText
    .replace(TRAILING_COMMENT, "")
    .replace(/"""[^]*?"""|'''[^]*?'''/g, "")
    .replace(/``[^`]*``/g, "");
  return noRst.includes("${") ? noRst : noRst.replace(/`[^`]*`/g, "");
}

/** A line that builds the config URL: code holding both halves of the path. */
function isBuilderLine(lineText) {
  const code = codeOf(lineText);
  return code.includes("configuration-files") && code.includes("config_v6.json");
}

/**
 * The builder lines of a whole file: lines inside a `/* … *\/` block or a
 * `"""` / `'''` docstring are prose, whatever their first characters.
 */
function builderLinesOf(text) {
  const out = [];
  let inBlock = false;
  let inDocstring = null;
  for (const lineText of text.split("\n")) {
    if (inBlock) {
      if (lineText.includes("*/")) inBlock = false;
      continue;
    }
    if (inDocstring !== null) {
      if (lineText.includes(inDocstring)) inDocstring = null;
      continue;
    }
    const opener = ['"""', "'''"].find((mark) => (lineText.split(mark).length - 1) % 2 === 1);
    if (opener !== undefined) {
      inDocstring = opener;
      continue;
    }
    const opens = lineText.lastIndexOf("/*");
    if (opens !== -1 && lineText.indexOf("*/", opens) === -1) inBlock = true;
    if (isBuilderLine(lineText)) out.push(lineText);
  }
  return out;
}

/** A cache-key tail, a hash of the key — never what goes in the path (FR-001). */
const CACHE_KEY_TAIL = /cache[_-]?key|(?<![a-z])tail\b|sha-?256|digest|hash/i;

/**
 * The SDKs that build no URL of their own: they fetch through
 * `packages/sdk-shared`, which the scan covers. Every other SDK must show the
 * scan its URL builder.
 */
const URL_FROM_SDK_SHARED = new Set([
  "apps/sdk-angular",
  "apps/sdk-browser-js",
  "apps/sdk-bun",
  "apps/sdk-cloudflare-worker",
  "apps/sdk-deno",
  "apps/sdk-node",
  "apps/sdk-react",
]);

function isScannedSource(path) {
  return SOURCE_FILE.test(path) && !TEST_FILE.test(path);
}

function offends(lineText) {
  return (
    V2_PATH.test(lineText) ||
    (lineText.includes("configuration-files") && CACHE_KEY_TAIL.test(lineText))
  );
}

const { trackedFiles, configPathLines, configPathFiles } = readSdkSources();
const scanned = new Set(trackedFiles.filter(isScannedSource));
const offendingLines = configPathLines.filter((hit) => scanned.has(hit.path) && offends(hit.text));

test("FR-005: the scan covers every SDK's sources — it cannot pass by reading nothing", () => {
  const sdkDirs = new Set(trackedFiles.map((path) => path.split("/").slice(0, 2).join("/")));
  const scannedDirs = new Set([...scanned].map((path) => path.split("/").slice(0, 2).join("/")));
  expect(sdkDirs.size, "tracked apps/sdk-* directories").toBeGreaterThanOrEqual(20);
  expect(sdkDirs.has("packages/sdk-shared"), "packages/sdk-shared is scanned").toBe(true);
  // The line filter delivered: every file that names the path handed its lines over.
  const linePaths = new Set(configPathLines.map((hit) => hit.path));
  expect(configPathFiles.length, "files naming configuration-files").toBeGreaterThanOrEqual(15);
  expect(configPathFiles.filter((file) => !linePaths.has(file.path)).map((f) => f.path)).toEqual(
    [],
  );
  expect([...sdkDirs].filter((dir) => !scannedDirs.has(dir))).toEqual([]);
});

test("FR-005: every SDK that builds its own URL shows the scan where", () => {
  const sdkDirs = new Set(trackedFiles.map((path) => path.split("/").slice(0, 2).join("/")));
  const withBuilder = new Set(
    configPathFiles
      .filter((file) => scanned.has(file.path) && builderLinesOf(file.text).length > 0)
      .map((file) => file.path.split("/").slice(0, 2).join("/")),
  );
  const unseen = [...sdkDirs].filter(
    (dir) => !URL_FROM_SDK_SHARED.has(dir) && !withBuilder.has(dir),
  );
  expect(
    unseen,
    "no code line builds `…/configuration-files/…/config_v6.json`: declare it in URL_FROM_SDK_SHARED or build the path literally",
  ).toEqual([]);
  const stale = [...URL_FROM_SDK_SHARED].filter((dir) => !sdkDirs.has(dir) || withBuilder.has(dir));
  expect(stale, "builds its own URL, or is gone: remove it from URL_FROM_SDK_SHARED").toEqual([]);
});

test("FR-005: no SDK source builds /v2/configuration-files or a cache-key-tail URL", () => {
  const unexpected = offendingLines.map((hit) => `${hit.path}:${hit.line}: ${hit.text.trim()}`);
  expect(unexpected, "the CDN serves /configuration-files/<sdkKey>/config_v6.json only").toEqual(
    [],
  );
});

test("FR-005: the line rule tells the old URL from FR-001's", () => {
  for (const bad of [
    'url = "$resolvedBase/v2/configuration-files/$tail/config_v6.json"',
    'os << baseUrl_ << "/configuration-files/" << tail << "/config_v6.json";',
    '@url = "#{@base_url}/configuration-files/#{cache_key_tail}/config_v6.json"',
    'URL(string: "\\(baseURL)/configuration-files/\\(cacheKeyTail)/config_v6.json")!',
    'TEXT("%s/configuration-files/%s/config_v6.json"), *BaseUrl, *Tail);',
    'f"{base}/configuration-files/{sha256(key)}/config_v6.json"',
    'let url = base + "/v2/" + "configuration-files/" + key + "/config_v6.json";',
    'private const val PREFIX = "/v2"',
    '"{}/configuration-files/{}/config_v6.json", base, digest)',
    'String.format("%s/configuration-files/%s/config_v6.json", base, keyHash)',
    'URL(string: "\\(baseURL)/v2/\\(keyPath)/config_v6.json")',
    'Base + TEXT("/v2/") + KeyPath',
    "return `${baseUrl}/v2/${keyPath}/config_v6.json`;",
    'fmt.Sprintf("%s/v2/%s/config_v6.json", base, key)',
    "// a comment that still mentions the /v2/ route",
    'baseURL.appendingPathComponent("v2").appendingPathComponent(keyPath)',
    '.appendPath("v2")',
    '"/".join([base, "v2", key_path, "config_v6.json"])',
    'const PREFIX = "/V2/";',
    'url = base + "v2/configuration-files/" + key + "/config_v6.json"',
    "'/'.join([base, 'v2', key_path])",
    "const segment = `v2`;",
    'URL(string: "\\(base)/v2")',
    "const prefix = `${base}/v2`;",
    "url = base + 'v2/configuration-files/' + key",
    "const p = `v2/configuration-files/${key}`;",
    "$url = $base . '/v2/' . $key;",
  ]) {
    expect(offends(bad), bad).toBe(true);
    // The line filter must hand every such line over, or the rule never sees it.
    expect(isCandidateLine(bad), `filtered out: ${bad}`).toBe(true);
  }
  for (const good of [
    'return f.baseURL + "/configuration-files/" + url.PathEscape(f.sdkKey) + "/config_v6.json"',
    "`${this.baseUrl}/configuration-files/${encodeURIComponent(sdkKey)}/config_v6.json` +",
    "f\"{self._base_url}/configuration-files/{quote(self._sdk_key, safe='')}/config_v6.json\"",
    "// the route the Worker serves — `/configuration-files/<sdkKey>/config_v6.json` (detail)",
    "    const auto v2 = SemVer::parse(item);",
  ]) {
    expect(offends(good), good).toBe(false);
  }
  // A builder is code: a doc comment or docstring saying the path does not count.
  for (const builder of [
    'guard let url = URL(string: "\\(baseURL)/configuration-files/\\(keyPath)/config_v6.json")',
    'return Base + TEXT("/configuration-files/") + KeyPath + TEXT("/config_v6.json");',
    "  return `${baseUrl}/configuration-files/${keyPath}/config_v6.json?sdk=${sdkVersion}`;",
    '      {:ok, "#{base}/configuration-files/#{segment}/config_v6.json"}',
    '            f"{self._base_url}/configuration-files/{key_path}/config_v6.json"',
  ]) {
    expect(isBuilderLine(builder), builder).toBe(true);
  }
  for (const doc of [
    "    /// `<base>/configuration-files/<sdkKey>/config_v6.json` — and the",
    '\t// (`url + "/configuration-files/" + sdkKey + "/" + kConfigJsonName`),',
    " * The request path is ConfigCat's `<base>/configuration-files/<sdkKey>/config_v6.json`, built in",
    "        ``{base_url}/configuration-files/{sdk_key}/config_v6.json``, no",
    "  The request URL is ConfigCat's `<baseUrl>/configuration-files/<sdkKey>/config_v6.json`,",
    "    # ConfigCat's `<base>/configuration-files/<sdkKey>/config_v6.json`.",
    'return x; // was "/configuration-files/" + key + "/config_v6.json"',
    '    """GET {base}/configuration-files/{key}/config_v6.json"""',
    "    '''GET {base}/configuration-files/{key}/config_v6.json'''",
  ]) {
    expect(isBuilderLine(doc), doc).toBe(false);
  }
  // Prose inside a block comment or a docstring is not a builder, whatever its
  // first characters; code after the block is.
  expect(
    builderLinesOf(
      [
        "/*",
        'base + "/configuration-files/" + key + "/config_v6.json"',
        "*/",
        '"""',
        'f"{base}/configuration-files/{key}/config_v6.json"',
        '"""',
        "'''",
        'f"{base}/configuration-files/{key}/config_v6.json"',
        "'''",
        '  @moduledoc """',
        '  "#{base}/configuration-files/#{key}/config_v6.json"',
        '  \"\"\"',
      ].join("\n"),
    ),
  ).toEqual([]);
  expect(
    builderLinesOf(
      ["/* a */", 'return base + "/configuration-files/" + k + "/config_v6.json";'].join("\n"),
    ),
  ).toHaveLength(1);
  expect(isScannedSource("apps/sdk-go/internal/configfetcher/fetcher.go")).toBe(true);
  for (const testPath of [
    "apps/sdk-go/wire_cases_test.go",
    "apps/sdk-node/tests/wire/wire-cases.test.ts",
    "apps/sdk-kotlin-mp/src/jvmTest/kotlin/io/confeature/kmp/WireCasesTest.kt",
    "apps/sdk-swift/Tests/ConfeatureTests/WireCasesTests.swift",
    "apps/sdk-unreal/Plugins/Confeature/Source/Confeature/Private/Tests/WireCasesTest.cpp",
    "apps/sdk-ruby/spec/wire/wire_cases_spec.rb",
    "apps/sdk-python/tests/wire/test_wire_cases.py",
  ]) {
    expect(isScannedSource(testPath), testPath).toBe(false);
  }
});
