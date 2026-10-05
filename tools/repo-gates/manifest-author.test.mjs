// SPDX-License-Identifier: MIT

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AUTHOR,
  AUTHOR_FIELDS,
  checkManifest,
  decode,
  main,
  manifestFindings,
  manifestKind,
  topLevelKeyLine,
} from "../manifest-author.mjs";

// The author rule (tools/manifest-author.mjs). Every case that plants an
// address in a manifest is a mutation case: the rule must refuse it. The
// address is a decoy on a reserved domain, and no finding may print it.

const RULE = fileURLToPath(new URL("../manifest-author.mjs", import.meta.url));
const AT = "someone@example.com";
const SPAWNS = { timeout: 60_000 };

describe("manifestKind", () => {
  it.each([
    ["apps/sdk-x/package.json", "npm"],
    ["apps/sdk-php/composer.json", "composer"],
    ["apps/cli/deno.json", "deno"],
    ["apps/sdk-unreal/Plugins/Confeature/Confeature.uplugin", "uplugin"],
    ["apps/sdk-python/pyproject.toml", "pyproject"],
    ["apps/sdk-rust/Cargo.toml", "cargo"],
    ["apps/sdk-ruby/confeature.gemspec", "gemspec"],
    ["apps/sdk-dotnet/src/Confeature.Client/Confeature.Client.csproj", "msbuild"],
    ["apps/sdk-dotnet/src/X/X.fsproj", "msbuild"],
    ["apps/sdk-dotnet/X.nuspec", "nuspec"],
    ["Directory.Build.props", "props"],
    ["build/Common.props", "props"],
    ["apps/sdk-dart/pubspec.yaml", "pubspec"],
    ["apps/sdk-elixir/mix.exs", "mix"],
    ["apps/sdk-java/build.gradle.kts", "gradle"],
    ["apps/sdk-java/gradle.properties", "gradle-properties"],
    ["apps/sdk-cpp/CMakeLists.txt", "cmake"],
    ["apps/sdk-x/LICENSE", "license"],
    ["LICENSE.md", "license"],
  ])("%s is a %s manifest", (path, kind) => {
    expect(manifestKind(path)).toBe(kind);
  });

  it("go.mod, Package.swift and source files are not manifests", () => {
    for (const p of ["apps/sdk-go/go.mod", "apps/sdk-swift/Package.swift", "src/index.ts"])
      expect(manifestKind(p)).toBeNull();
  });
});

describe("decode — an address cannot hide behind an encoding", () => {
  it.each([
    ["\\u0040", "@"],
    ["\\x40", "@"],
    ["\\u{40}", "@"],
    ["%40", "@"],
    ["%2540", "@"],
    ["&#64;", "@"],
    ["&#x40;", "@"],
    ["&commat;", "@"],
    ["&amp;#64;", "@"],
    ["＠", "@"],
    ["Maker\u200bLabs", "MakerLabs"],
  ])("%s decodes to %s", (input, want) => {
    expect(decode(input)).toBe(want);
  });

  it("never throws on an out-of-range code point", () => {
    expect(decode("&#99999999;")).toBe("&#99999999;");
  });
});

const MISSING = /no author/;
const NOT_AUTHOR = /not exactly MakerLabs/;
const why = (path, text) => manifestFindings(path, text).map((f) => `${String(f.line)} ${f.why}`);

describe("REQUIRED — a published manifest names MakerLabs; absence is allowed only where the table says", () => {
  it.each([
    ["npm", "package.json", JSON.stringify({ name: "x", author: AUTHOR })],
    ["npm, object form", "package.json", JSON.stringify({ name: "x", author: { name: AUTHOR } })],
    ["npm, private", "package.json", JSON.stringify({ name: "x", private: true })],
    ["composer", "composer.json", JSON.stringify({ authors: [{ name: AUTHOR }] })],
    ["uplugin", "X.uplugin", JSON.stringify({ CreatedBy: AUTHOR, CreatedByURL: "https://x.test" })],
    [
      "pyproject, inline",
      "pyproject.toml",
      '[project]\nname = "x"\nauthors = [{ name = "MakerLabs" }]\n',
    ],
    [
      "pyproject, tables",
      "pyproject.toml",
      '[project]\nname = "x"\n\n[[project.authors]]\nname = "MakerLabs"\n',
    ],
    ["pyproject, tool config only", "pyproject.toml", "[tool.ruff]\nline-length = 100\n"],
    ["cargo", "Cargo.toml", '[package]\nname = "x"\nauthors = ["MakerLabs"]\n'],
    ["cargo, publish = false", "Cargo.toml", '[package]\nname = "x"\npublish = false\n'],
    ["cargo, workspace only", "Cargo.toml", '[workspace]\nmembers = ["a"]\n'],
    [
      "gemspec",
      "x.gemspec",
      'Gem::Specification.new do |spec|\n  spec.authors = ["MakerLabs"]\nend\n',
    ],
    [
      "csproj",
      "x.csproj",
      "<Project><PropertyGroup><Authors>MakerLabs</Authors></PropertyGroup></Project>",
    ],
    [
      "csproj, not packable",
      "x.csproj",
      "<Project><PropertyGroup><IsPackable>false</IsPackable></PropertyGroup></Project>",
    ],
    ["nuspec", "x.nuspec", "<package><metadata><authors>MakerLabs</authors></metadata></package>"],
    [
      "props, no author",
      "Directory.Build.props",
      "<Project><PropertyGroup><LangVersion>12</LangVersion></PropertyGroup></Project>",
    ],
    ["pubspec, no author field in that ecosystem", "pubspec.yaml", "name: x\nversion: 0.1.0\n"],
    [
      "mix",
      "mix.exs",
      'package: [maintainers: ["MakerLabs"], links: %{"GitHub" => "https://x.test"}]',
    ],
    ["mix, no package", "mix.exs", "def project, do: [app: :x]\n"],
    [
      "gradle, publishing",
      "build.gradle.kts",
      'plugins { `maven-publish` }\npom { developers { developer { name.set("MakerLabs") } } }',
    ],
    ["gradle, not publishing", "build.gradle.kts", 'plugins { java }\ngroup = "io.x"\n'],
    ["deno.json", "deno.json", JSON.stringify({ tasks: { test: "deno test" } })],
    [
      "gradle.properties",
      "gradle.properties",
      "POM_DEVELOPER_NAME=MakerLabs\nPOM_URL=https://x.test\n",
    ],
    ["CMake, vendor", "CMakeLists.txt", 'set(CPACK_PACKAGE_VENDOR "MakerLabs")\n'],
    ["CMake, none", "CMakeLists.txt", "project(x)\n"],
    ["LICENSE", "LICENSE", "MIT License\n\nCopyright (c) 2026 MakerLabs\n"],
  ])("accepts %s", (_name, path, text) => {
    expect(manifestFindings(path, text)).toEqual([]);
  });

  // MUTATION CASES: each published manifest below names no author. Drop the
  // REQUIRED rule for its ecosystem and its row turns green.
  it.each([
    ["npm, not private", "package.json", JSON.stringify({ name: "x" })],
    ["npm, private: false", "package.json", JSON.stringify({ name: "x", private: false })],
    [
      "npm, contributors only",
      "package.json",
      JSON.stringify({ name: "x", contributors: [AUTHOR] }),
    ],
    ["composer", "composer.json", JSON.stringify({ name: "x/y" })],
    ["uplugin", "X.uplugin", JSON.stringify({ FriendlyName: "x" })],
    ["pyproject", "pyproject.toml", '[project]\nname = "x"\n'],
    ["pyproject, maintainers only", "pyproject.toml", '[project]\nmaintainers = ["MakerLabs"]\n'],
    ["cargo", "Cargo.toml", '[package]\nname = "x"\n'],
    ["gemspec", "x.gemspec", 'Gem::Specification.new do |s|\n  s.name = "x"\nend\n'],
    [
      "csproj, packable",
      "x.csproj",
      "<Project><PropertyGroup><PackageId>X</PackageId></PropertyGroup></Project>",
    ],
    ["fsproj", "x.fsproj", "<Project><PropertyGroup /></Project>"],
    ["nuspec", "x.nuspec", "<package><metadata><id>X</id></metadata></package>"],
    ["mix, package without maintainers", "mix.exs", 'package: [licenses: ["MIT"]]'],
    ["gradle, publishing without developers", "build.gradle.kts", "plugins { `maven-publish` }\n"],
  ])("refuses %s with no author", (_name, path, text) => {
    expect(why(path, text)).toEqual([expect.stringMatching(MISSING)]);
  });

  it("names every ecosystem with an author field in the table", () => {
    expect(Object.keys(AUTHOR_FIELDS).sort()).toEqual(
      [
        "cargo",
        "composer",
        "gemspec",
        "gradle",
        "mix",
        "msbuild",
        "npm",
        "nuspec",
        "pyproject",
        "uplugin",
      ].sort(),
    );
  });
});

describe("identity and contact fields — MakerLabs, and no address anywhere", () => {
  // MUTATION CASES: each plants a personal name or an address.
  it.each([
    [
      "npm author with address",
      "package.json",
      `{\n  "name": "x",\n  "author": "Jane Doe <${AT}>"\n}`,
      [3],
    ],
    [
      "npm author object with email",
      "package.json",
      `{\n  "author": { "name": "MakerLabs", "email": "${AT}" }\n}`,
      [2],
    ],
    ["npm author is a person", "package.json", `{\n  "author": "Jane Doe"\n}`, [2]],
    [
      "npm empty author list",
      "package.json",
      `{\n  "author": "MakerLabs",\n  "contributors": []\n}`,
      [3],
    ],
    [
      "npm contributor is a person",
      "package.json",
      `{\n  "author": "MakerLabs",\n  "contributors": ["Jane"]\n}`,
      [3],
    ],
    [
      "npm maintainer with email",
      "package.json",
      `{\n  "author": "MakerLabs",\n  "maintainers": [{ "name": "MakerLabs", "email": "${AT}" }]\n}`,
      [3],
    ],
    ["npm owners", "package.json", `{\n  "author": "MakerLabs",\n  "owners": "Jane"\n}`, [3]],
    [
      "npm bugs email",
      "package.json",
      `{\n  "author": "MakerLabs",\n  "bugs": { "email": "${AT}" }\n}`,
      [3],
    ],
    ["npm escaped @", "package.json", '{\n  "author": "MakerLabs\\u0040example.com"\n}', [2]],
    ["npm entity @", "package.json", '{\n  "author": "MakerLabs&#64;example.com"\n}', [2]],
    [
      "composer author email",
      "composer.json",
      `{\n  "authors": [{ "name": "MakerLabs", "email": "${AT}" }]\n}`,
      [2],
    ],
    [
      "composer support email",
      "composer.json",
      `{\n  "authors": [{ "name": "MakerLabs" }],\n  "support": { "email": "${AT}" }\n}`,
      [3],
    ],
    ["uplugin CreatedBy person", "X.uplugin", `{\n  "CreatedBy": "Jane"\n}`, [2]],
    [
      "uplugin support mailto",
      "X.uplugin",
      `{\n  "CreatedBy": "MakerLabs",\n  "SupportURL": "mailto:${AT}"\n}`,
      [3],
    ],
    [
      "pyproject author email",
      "pyproject.toml",
      `[project]\nauthors = [{ name = "MakerLabs", email = "${AT}" }]\n`,
      [2],
    ],
    [
      "pyproject table email",
      "pyproject.toml",
      `[project]\n\n[[project.authors]]\nname = "MakerLabs"\nemail = "${AT}"\n`,
      [3],
    ],
    [
      "pyproject maintainer person",
      "pyproject.toml",
      '[project]\nauthors = ["MakerLabs"]\n"maintainers" = ["Jane Doe"]\n',
      [3],
    ],
    ["cargo author address", "Cargo.toml", `[package]\nauthors = ["MakerLabs <${AT}>"]\n`, [2]],
    [
      "gemspec email",
      "x.gemspec",
      `Gem::Specification.new do |s|\n  s.authors = ["MakerLabs"]\n  s.email = ["${AT}"]\nend\n`,
      [3],
    ],
    [
      "gemspec word list",
      "x.gemspec",
      "Gem::Specification.new do |s|\n  s.authors = %w[jane]\nend\n",
      [2],
    ],
    ["csproj author person", "x.csproj", "<Project>\n<Authors>Jane Doe</Authors>\n</Project>", [2]],
    [
      "csproj author with attribute",
      "x.csproj",
      '<Project>\n<Authors Condition="true">Jane</Authors>\n</Project>',
      [2],
    ],
    ["csproj lower-case tag", "x.csproj", "<Project>\n<authors>Jane</authors>\n</Project>", [2]],
    [
      "csproj owners",
      "x.csproj",
      "<Project>\n<Authors>MakerLabs</Authors>\n<Owners>Jane</Owners>\n</Project>",
      [3],
    ],
    [
      "csproj company",
      "x.csproj",
      "<Project>\n<Authors>MakerLabs</Authors>\n<Company>Jane Ltd</Company>\n</Project>",
      [3],
    ],
    ["csproj empty author", "x.csproj", "<Project>\n<Authors />\n</Project>", [2]],
    [
      "csproj copyright address",
      "x.csproj",
      `<Project>\n<Authors>MakerLabs</Authors>\n<Copyright>${AT}</Copyright>\n</Project>`,
      [3],
    ],
    ["nuspec author person", "x.nuspec", "<package>\n<authors>Jane</authors>\n</package>", [2]],
    ["props author person", "Common.props", "<Project>\n<Authors>Jane</Authors>\n</Project>", [2]],
    ["pubspec author address", "pubspec.yaml", `name: x\nauthor: Jane <${AT}>\n`, [2]],
    ["pubspec author list", "pubspec.yaml", `name: x\nauthors:\n  - MakerLabs\n  - ${AT}\n`, [2]],
    ["mix maintainer address", "mix.exs", `package: [\n  maintainers: ["${AT}"]\n]`, [2]],
    [
      "mix authors person",
      "mix.exs",
      'package: [\n  maintainers: ["MakerLabs"],\n  authors: ["Jane"]\n]',
      [3],
    ],
    [
      "mix mail link",
      "mix.exs",
      `package: [\n  maintainers: ["MakerLabs"],\n  links: %{"Mail" => "mailto:${AT}"}\n]`,
      [3],
    ],
    [
      "gradle developer email",
      "build.gradle.kts",
      `developer {\n  name.set("MakerLabs")\n  email.set("${AT}")\n}`,
      [1],
    ],
    [
      "gradle developer person",
      "build.gradle.kts",
      'pom {\n  developers {\n    developer { name.set("Jane") }\n  }\n}',
      [3],
    ],
    ["gradle developer, no name", "build.gradle.kts", 'developer {\n  id.set("jane")\n}', [1]],
    ["gradle.properties developer name", "gradle.properties", "POM_DEVELOPER_NAME=Jane\n", [1]],
    ["gradle.properties email", "gradle.properties", `POM_DEVELOPER_EMAIL=${AT}\n`, [1]],
    [
      "CMake vendor person",
      "CMakeLists.txt",
      'project(x)\nset(CPACK_PACKAGE_VENDOR "Jane")\n',
      [2],
    ],
    [
      "CMake maintainer person",
      "CMakeLists.txt",
      'set(CPACK_DEBIAN_PACKAGE_MAINTAINER "Jane")\n',
      [1],
    ],
    ["CMake contact address", "CMakeLists.txt", `set(CPACK_PACKAGE_CONTACT "${AT}")\n`, [1]],
    [
      "LICENSE copyright address",
      "LICENSE",
      `MIT License\n\nCopyright (c) 2026 Jane <${AT}>\n`,
      [3],
    ],
  ])("refuses %s (line %j)", (_name, path, text, lines) => {
    expect(checkManifest(path, text)).toEqual(lines);
  });

  it("reports a top-level key at its own line, not a nested key of the same name", () => {
    const text = '{\n  "x": { "author": "nested" },\n  "author": "Jane"\n}';
    expect(topLevelKeyLine(text, "author")).toBe(3);
    expect(checkManifest("package.json", text)).toEqual([3]);
  });

  it("refuses a JSON manifest it cannot parse, rather than passing it", () => {
    expect(() => checkManifest("package.json", "{ not json")).toThrow(SyntaxError);
  });

  it("the finding says why, never what", () => {
    const [f] = manifestFindings("package.json", `{"author": "Jane <${AT}>"}`);
    expect(f.why).toMatch(NOT_AUTHOR);
    expect(JSON.stringify(f)).not.toContain(AT);
  });
});

// ---------------------------------------------------------------------------
describe("the CLI", SPAWNS, () => {
  let root;
  const write = (rel, body) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  };
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    });
  const run = (args = []) => spawnSync(process.execPath, [RULE, ...args], { cwd: root });
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "manifest-author-"));
    git("init", "-q");
    write("package.json", JSON.stringify({ name: "root", author: AUTHOR }));
    write("apps/sdk-x/package.json", JSON.stringify({ name: "x", author: AUTHOR }));
    write("apps/sdk-y/Cargo.toml", '[package]\nauthors = ["MakerLabs"]\n');
    git("add", "-A");
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("passes a clean tree and says how many manifests it read", () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout.toString()).toMatch(/3 manifests/);
  });

  it("MUTATION: an address planted in a tracked manifest fails it, and is never printed", () => {
    write("apps/sdk-x/package.json", `{\n  "name": "x",\n  "author": "Jane <${AT}>"\n}\n`);
    git("add", "-A");
    const r = run();
    expect(r.status).toBe(1);
    const out = `${r.stdout.toString()}${r.stderr.toString()}`;
    expect(out).toContain("apps/sdk-x/package.json:3");
    expect(out).not.toContain(AT);
    expect(out).not.toContain("Jane");
  });

  it("reads the files it is given, instead of every tracked one", () => {
    write("other/package.json", `{"author": "${AT}"}`);
    expect(run(["apps/sdk-x/package.json"]).status).toBe(0);
    expect(run(["other/package.json"]).status).toBe(1);
  });

  it("an unparseable manifest is a finding, named by its error class", () => {
    write("apps/sdk-x/package.json", "{ broken");
    git("add", "-A");
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr.toString()).toMatch(
      /apps\/sdk-x\/package\.json:0: cannot be parsed \(SyntaxError\)/,
    );
  });

  it("a named file that is not a manifest is an error, never a silent drop", () => {
    // MUTATION: filter unknown names out instead and this exits 0.
    write("README.md", "# x\n");
    const r = run(["apps/sdk-x/package.json", "README.md"]);
    expect(r.status).toBe(2);
    expect(r.stderr.toString()).toMatch(/README\.md: not a manifest/);
  });

  it("fails closed when there is nothing to check", () => {
    git("rm", "-q", "--cached", "-r", ".");
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr.toString()).toMatch(/no manifest/);
  });

  it("fails closed outside a git checkout", () => {
    rmSync(join(root, ".git"), { recursive: true, force: true });
    expect(run().status).toBe(2);
  });

  it("main() returns the exit code", () => {
    const sink = { write: () => true };
    expect(main(["apps/sdk-x/package.json"], { root, out: sink, err: sink })).toBe(0);
  });
});
