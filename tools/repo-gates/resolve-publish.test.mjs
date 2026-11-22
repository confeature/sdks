// SPDX-License-Identifier: MIT

// The publish-tag resolver (tools/sdk-pack/resolve-publish.mjs). Two halves:
// - the REAL manifest: every unit resolves or is refused for its declared reason;
// - a fixture manifest: one case per refusal, so each rule is seen to fail closed.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  InputError,
  MANIFEST,
  OUTPUT_KEYS,
  checkSafe,
  httpExists,
  Refusal,
  parseArgs,
  registryUrl,
  resolvePublish,
  tagRegex,
} from "../sdk-pack/resolve-publish.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REAL = JSON.parse(readFileSync(join(ROOT, MANIFEST), "utf8"));
const PYTHON_VERSION = /^version = "([^"]+)"$/m.exec(
  readFileSync(join(ROOT, "apps/sdk-python/pyproject.toml"), "utf8"),
)?.[1];
if (!PYTHON_VERSION) throw new Error("Expected a declared Python version in pyproject.toml");
const PYTHON_TAG = `sdk-python-v${PYTHON_VERSION}`;
const GO_VERSION = /^const Version = "([^"]+)"$/m.exec(
  readFileSync(join(ROOT, "apps/sdk-go/version.go"), "utf8"),
)?.[1];
if (!GO_VERSION) throw new Error("Expected a declared Go version in version.go");
const published = async () => true;
const MAIN = { mainRef: "origin/main", isOnMain: () => true };
const unpublished = async () => false;

describe("the Go release prerequisite", () => {
  const coordinates = "github.com/confeature/sdks/apps/sdk-go";
  const parent = { registry: "go", coordinates, version: "0.2.0" };
  const url = `https://proxy.golang.org/${coordinates}/@v/v0.2.0.mod`;

  it("reads the exact first-party module and version with redirects refused", async () => {
    expect(registryUrl(parent, parent.version)).toBe(url);
    expect(registryUrl(parent, "0.2.0/../0.1.1")).toBeNull();
    expect(
      registryUrl({ ...parent, coordinates: coordinates + "/openfeature" }, "0.2.0"),
    ).toBeNull();
    await expect(
      httpExists(url, parent, async (target, options) => {
        expect(target).toBe(url);
        expect(options).toEqual({
          method: "GET",
          headers: { accept: "text/plain" },
          redirect: "error",
        });
        return new Response(`module ${coordinates}\n\ngo 1.23\n`);
      }),
    ).resolves.toBe(true);
  });

  it("refuses a missing, mismatched or invalid module declaration", async () => {
    await expect(
      httpExists(url, parent, async () => new Response(null, { status: 404 })),
    ).resolves.toBe(false);
    for (const manifest of [
      `module ${coordinates}/other\n`,
      `module ${coordinates} extra\n`,
      `module ${coordinates}\nmodule ${coordinates}\n`,
      `// module ${coordinates}\n`,
    ]) {
      await expect(httpExists(url, parent, async () => new Response(manifest))).rejects.toThrow(
        /expected Go module/,
      );
    }
  });
});

describe("the Maven release prerequisite", () => {
  const parent = {
    registry: "maven",
    coordinates: "io.confeature:confeature-java-client",
    version: "0.2.0",
  };
  const url =
    "https://maven.confeature.io/io/confeature/confeature-java-client/0.2.0/confeature-java-client-0.2.0.pom";
  const identity =
    "<modelVersion>4.0.0</modelVersion><groupId>io.confeature</groupId><artifactId>confeature-java-client</artifactId><version>0.2.0</version>";
  const pom = `<project>${identity}</project>`;

  it("checks only the exact first-party package and version", async () => {
    expect(registryUrl(parent, parent.version)).toBe(url);
    expect(
      registryUrl({ ...parent, coordinates: "io.confeature:a/../b" }, parent.version),
    ).toBeNull();
    expect(registryUrl(parent, "0.2.0/../0.1.1")).toBeNull();
    expect(registryUrl({ ...parent, coordinates: "external:client" }, parent.version)).toBeNull();
    await expect(
      httpExists(url, parent, async (target, options) => {
        expect(target).toBe(url);
        expect(options).toEqual({
          method: "GET",
          headers: { accept: "application/xml" },
          redirect: "error",
        });
        return new Response(pom);
      }),
    ).resolves.toBe(true);
  });

  it("refuses missing, mismatched, redirected and unexpected registry responses", async () => {
    await expect(
      httpExists(url, parent, async () => new Response(null, { status: 404 })),
    ).resolves.toBe(false);
    for (const body of [
      pom.replace("0.2.0", "0.1.1"),
      `<project><parent>${identity}</parent></project>`,
      `<project><properties>${identity}</properties></project>`,
      `<project>${identity}<version>0.2.0</version></project>`,
      `<project>${identity}<dependencies></project>`,
      `<other>${pom}</other>`,
      pom + pom,
      "not XML",
    ]) {
      await expect(httpExists(url, parent, async () => new Response(body))).rejects.toThrow(
        /expected Maven project/,
      );
    }
    await expect(
      httpExists(url, parent, async () => new Response(null, { status: 503 })),
    ).rejects.toThrow(/503/);
    await expect(
      httpExists(url, parent, async () => {
        throw new TypeError("redirect");
      }),
    ).rejects.toThrow(/cannot reach/);
  });
});

describe("the NuGet release prerequisite", () => {
  const parent = { registry: "nuget", coordinates: "Confeature.Client", version: "0.2.0" };
  const url =
    "https://api.nuget.org/v3-flatcontainer/confeature.client/0.2.0/confeature.client.nuspec";
  const identity = "<id>Confeature.Client</id><version>0.2.0</version>";
  const nuspec = `<?xml version="1.0"?><package xmlns="http://schemas.microsoft.com/packaging/2013/05/nuspec.xsd"><metadata>${identity}</metadata></package>`;

  it("looks up only the normalized package ID and version without redirects", async () => {
    expect(registryUrl(parent, parent.version)).toBe(url);
    expect(registryUrl(parent, "0.2.0-RC.1")).toBe(url.replace("/0.2.0/", "/0.2.0-rc.1/"));
    expect(
      registryUrl({ ...parent, coordinates: "Confeature/../Client" }, parent.version),
    ).toBeNull();
    expect(registryUrl(parent, "0.2.0/../0.1.1")).toBeNull();
    await expect(
      httpExists(url, parent, async (target, options) => {
        expect(target).toBe(url);
        expect(options).toEqual({
          method: "GET",
          headers: { accept: "application/xml" },
          redirect: "error",
        });
        return new Response(nuspec.replace("Confeature.Client", "confeature.client"));
      }),
    ).resolves.toBe(true);
  });

  it("refuses missing or ambiguous direct identity fields", async () => {
    await expect(
      httpExists(url, parent, async () => new Response(null, { status: 404 })),
    ).resolves.toBe(false);
    for (const body of [
      nuspec.replace("0.2.0", "0.1.1"),
      nuspec.replace("Confeature.Client", "Confeature.Other"),
      `<package><metadata><other>${identity}</other></metadata></package>`,
      `<package><other><metadata>${identity}</metadata></other></package>`,
      `<package><metadata>${identity}<version>0.2.0</version></metadata></package>`,
      `<package><metadata>${identity}</metadata><metadata /></package>`,
      `<package><metadata>${identity}</package>`,
      nuspec.replace("<metadata>", '<metadata name="a" name="b">'),
      nuspec.replace('version="1.0"', "invalid"),
      nuspec.replace("<metadata>", "<!-- invalid -- comment --><metadata>"),
      nuspec + nuspec,
    ]) {
      await expect(httpExists(url, parent, async () => new Response(body))).rejects.toThrow(
        /expected NuGet package/,
      );
    }
  });
});

describe("the real publish table", () => {
  // A jsr entry rides along its unit's primary entry (#935, jsr-unit.test.mjs).
  const PRIMARIES = REAL.publish.filter((u) => u.registry !== "jsr");
  it("has one primary unit per SDK plus shared and the OpenFeature companions", () => {
    const byName = (a, b) => a.localeCompare(b);
    const units = PRIMARIES.map((u) => u.name).sort(byName);
    const expected = [
      ...REAL.sdks.map((s) => s.name),
      "shared",
      "openfeature-node",
      "openfeature-browser",
      "openfeature-dotnet",
      "openfeature-go",
      "openfeature-java",
      "openfeature-kotlin",
      "openfeature-ruby",
    ].sort(byName);
    expect(units).toEqual(expected);
  });

  it.each(PRIMARIES.map((u) => [u.name, u]))(
    "unit %s resolves, or is refused for its declared reason",
    async (name, unit) => {
      const version = unit.versionSource === "tag" ? "0.1.0" : undefined;
      const run = () => resolvePublish({ root: ROOT, unit: name, version });
      if (unit.registry === "none") return expect(run()).rejects.toThrow(/has no registry/);
      if (unit.blockedBy) return expect(run()).rejects.toThrow(/is blocked by/);
      const out = await run();
      expect(out.name).toBe(name);
      expect(out.registry).toBe(unit.registry);
      expect(out.coordinates).toBe(unit.coordinates);
      expect(out.version).toMatch(/^\d+\.\d+\.\d+/);
    },
  );

  // #805 closed (mix compile works outside MIX_ENV=test): Hex ships (#909).
  it("the Hex unit resolves: nothing is blocked any more", async () => {
    expect(REAL.publish.filter((u) => u.blockedBy !== undefined)).toEqual([]);
    const out = await resolvePublish({ root: ROOT, unit: "elixir" });
    expect(out).toMatchObject({
      registry: "hex",
      coordinates: "confeature_client",
      path: "apps/sdk-elixir",
      gate: "test",
      daggerFn: "elixir-test",
    });
  });

  it("a release tag carries the declared version, never a substring of the tag", async () => {
    const out = await resolvePublish({
      root: ROOT,
      tag: PYTHON_TAG,
      exists: published,
      ...MAIN,
    });
    expect(out).toMatchObject({
      name: "python",
      registry: "pypi",
      version: PYTHON_VERSION,
      gate: "test",
      daggerFn: "python-test",
    });
  });

  it("the .NET OpenFeature release requires the published base package", async () => {
    const base = await resolvePublish({ root: ROOT, unit: "dotnet" });
    const companion = await resolvePublish({ root: ROOT, unit: "openfeature-dotnet" });
    const tag = `sdk-openfeature-dotnet-v${companion.version}`;
    const expectBase = (present) => async (url, dependency) => {
      expect(url).toBe(
        `https://api.nuget.org/v3-flatcontainer/confeature.client/${base.version}/confeature.client.nuspec`,
      );
      expect(dependency).toMatchObject({
        registry: "nuget",
        coordinates: "Confeature.Client",
        version: base.version,
      });
      return present;
    };

    await expect(
      resolvePublish({ root: ROOT, tag, exists: expectBase(false), ...MAIN }),
    ).rejects.toThrow(/must follow Confeature\.Client@.*not published yet/);
    await expect(
      resolvePublish({ root: ROOT, tag, exists: expectBase(true), ...MAIN }),
    ).resolves.toMatchObject({
      name: "openfeature-dotnet",
      registry: "nuget",
      coordinates: "Confeature.OpenFeature",
      daggerFn: "dotnet-test",
    });
  });
});

it("fills a mirror's tags from its unit", async () => {
  const php = await resolvePublish({ root: ROOT, tag: "sdk-php-v0.1.0", ...MAIN });
  expect(php).toMatchObject({
    mirrorRepository: "confeature/confeature-php-sdk",
    mirrorTag: "v0.1.0",
  });
});

it("resolves the base Go release from its source declaration", async () => {
  const go = await resolvePublish({ root: ROOT, tag: `sdk-go-v${GO_VERSION}`, ...MAIN });
  expect(go).toMatchObject({
    name: "go",
    path: "apps/sdk-go",
    version: GO_VERSION,
    releaseTag: `apps/sdk-go/v${GO_VERSION}`,
  });
  const other = GO_VERSION === "0.0.0" ? "0.0.1" : "0.0.0";
  await expect(resolvePublish({ root: ROOT, tag: `sdk-go-v${other}`, ...MAIN })).rejects.toThrow(
    /tag version .* differs from the .* that go declares/,
  );
});

it("resolves the nested Go module only after the pinned base release", async () => {
  const [base, companion] = ["go", "openfeature-go"].map((name) =>
    REAL.publish.find((unit) => unit.name === name),
  );
  const root = fixture([base, companion], [covered("go")], {
    [base.versionSource.file]: 'const Version = "9.9.9"\n',
    [companion.versionSource.file]: 'const Version = "0.1.0"\n',
    [`${companion.path}/go.mod`]: `module ${companion.coordinates}\nrequire (\n\t${base.coordinates} v0.2.0\n)\n`,
  });
  const release = { root, tag: "sdk-openfeature-go-v0.1.0", ...MAIN };
  const resolved = await resolvePublish({
    ...release,
    exists: async (url, dependency) => {
      expect(url).toBe(`https://proxy.golang.org/${base.coordinates}/@v/v0.2.0.mod`);
      expect(dependency).toEqual({
        registry: "go",
        coordinates: base.coordinates,
        version: "0.2.0",
      });
      return true;
    },
  });
  expect(resolved).toMatchObject({
    coordinates: `${base.coordinates}/openfeature`,
    gate: "test",
    daggerFn: "go-test",
    releaseTag: "apps/sdk-go/openfeature/v0.1.0",
  });
  await expect(resolvePublish({ ...release, exists: unpublished })).rejects.toThrow(
    /not published yet/,
  );
});

describe("tagFormat", () => {
  const re = tagRegex("sdk-{name}-v{version}");
  it.each([
    ["sdk-node-v0.1.0", "node", "0.1.0"],
    ["sdk-kotlin-mp-v1.20.3", "kotlin-mp", "1.20.3"],
    ["sdk-openfeature-kotlin-v0.1.0", "openfeature-kotlin", "0.1.0"],
    ["sdk-cloudflare-worker-v2.0.0-rc.1", "cloudflare-worker", "2.0.0-rc.1"],
  ])("accepts %s", (tag, name, version) => expect(re.exec(tag)?.groups).toEqual({ name, version }));
  it.each([
    "sdk-node-v01.0.0",
    "sdk-node-v1.0",
    "sdk-node-v1.0.0+build",
    "sdk-Node-v1.0.0",
    "sdk-node-v1.0.0;rm",
    "sdk-node-v1.0.0 ",
    "xsdk-node-v1.0.0",
    "sdk--v1.0.0",
    "sdk-node-1.0.0",
  ])("refuses %j", (tag) => expect(re.test(tag)).toBe(false));
});

/** A minimal repository: a manifest and the files its units read their versions from. */
const roots = [];
afterAll(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
function fixture(publish, sdks, files = {}) {
  const root = mkdtempSync(join(tmpdir(), "resolve-publish-"));
  roots.push(root);
  mkdirSync(join(root, "dagger"));
  writeFileSync(
    join(root, MANIFEST),
    JSON.stringify({ sdks, tagFormat: "sdk-{name}-v{version}", publish }),
  );
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const unit = (over = {}) => ({
  name: "a",
  gate: "a",
  registry: "npm",
  coordinates: "@x/a",
  path: "a",
  versionSource: { file: "a/v.txt", pattern: "^version=(\\S+)$" },
  after: [],
  ...over,
});
const covered = (name = "a") => ({ name, status: "covered", daggerFn: `${name}-test` });

describe("every refusal fails closed", () => {
  const base = { "a/v.txt": "version=1.2.3\n", "b/v.txt": "version=0.4.0\n" };
  const refused = (root, args, re) =>
    expect(resolvePublish({ root, exists: published, ...MAIN, ...args })).rejects.toThrow(re);

  it("accepts the happy path (control)", async () => {
    const root = fixture([unit()], [covered()], base);
    await expect(resolvePublish({ root, tag: "sdk-a-v1.2.3", ...MAIN })).resolves.toMatchObject({
      version: "1.2.3",
      gate: "test",
    });
  });
  it("a tag not shaped as tagFormat", () =>
    refused(fixture([unit()], [covered()], base), { tag: "a-1.2.3" }, /not shaped/));
  it("an unknown unit", () =>
    refused(fixture([unit()], [covered()], base), { tag: "sdk-b-v1.2.3" }, /no publish unit/));
  it("registry none", () =>
    refused(
      fixture([unit({ registry: "none", reason: "why" })], [covered()], base),
      { tag: "sdk-a-v1.2.3" },
      /no registry: why/,
    ));
  it("a unit that names no registry", () =>
    refused(
      fixture([unit({ registry: "" })], [covered()], base),
      { tag: "sdk-a-v1.2.3" },
      /names no registry/,
    ));
  it("blockedBy", () =>
    refused(
      fixture([unit({ blockedBy: "#1" })], [covered()], base),
      { tag: "sdk-a-v1.2.3" },
      /blocked by #1/,
    ));
  it("a pending gate", () =>
    refused(
      fixture([unit()], [{ name: "a", status: "pending" }], base),
      { tag: "sdk-a-v1.2.3" },
      /pending/,
    ));
  it("a gate missing from the roster", () =>
    refused(fixture([unit()], [], base), { tag: "sdk-a-v1.2.3" }, /not in the .sdks roster/));
  it("a covered gate with no daggerFn", () =>
    refused(
      fixture([unit()], [{ name: "a", status: "covered" }], base),
      { tag: "sdk-a-v1.2.3" },
      /no daggerFn/,
    ));
  it("a version mismatch", () =>
    refused(fixture([unit()], [covered()], base), { tag: "sdk-a-v1.2.4" }, /differs/));
  it("a version declared twice", () =>
    refused(
      fixture([unit()], [covered()], { "a/v.txt": "version=1.2.3\nversion=1.2.3\n" }),
      { tag: "sdk-a-v1.2.3" },
      /exactly once/,
    ));
  it("a version file that is missing is an input error (exit 2), not a refusal", () =>
    expect(
      resolvePublish({ root: fixture([unit()], [covered()], {}), tag: "sdk-a-v1.2.3", ...MAIN }),
    ).rejects.toBeInstanceOf(InputError));
  it("a declared version that is not semver", () =>
    refused(
      fixture([unit()], [covered()], { "a/v.txt": "version=1.2\n" }),
      { unit: "a" },
      /not semver/,
    ));
  it("an unmet after dependency", async () => {
    const root = fixture(
      [
        unit({ after: ["b"] }),
        unit({
          name: "b",
          gate: "b",
          coordinates: "@x/b",
          versionSource: { file: "b/v.txt", pattern: "^version=(\\S+)$" },
        }),
      ],
      [covered(), covered("b")],
      base,
    );
    await expect(
      resolvePublish({ root, tag: "sdk-a-v1.2.3", exists: unpublished, ...MAIN }),
    ).rejects.toThrow(/@x\/b@0.4.0, which is not published yet/);
    await expect(
      resolvePublish({ root, tag: "sdk-a-v1.2.3", exists: published, ...MAIN }),
    ).resolves.toMatchObject({ name: "a" });
  });
  it("resolves a NuGet after dependency from its exact published manifest", async () => {
    const root = fixture(
      [
        unit({ registry: "nuget", coordinates: "Confeature.OpenFeature", after: ["b"] }),
        unit({
          name: "b",
          gate: "b",
          registry: "nuget",
          coordinates: "Confeature.Client",
          versionSource: { file: "b/v.txt", pattern: "^version=(\\S+)$" },
        }),
      ],
      [covered(), covered("b")],
      base,
    );
    const options = { root, tag: "sdk-a-v1.2.3", ...MAIN };
    await expect(resolvePublish({ ...options, exists: unpublished })).rejects.toThrow(
      /Confeature\.Client@0\.4\.0, which is not published yet/,
    );
    await expect(
      resolvePublish({
        ...options,
        exists: async (url, dependency) => {
          expect(url).toBe(
            "https://api.nuget.org/v3-flatcontainer/confeature.client/0.4.0/confeature.client.nuspec",
          );
          return httpExists(
            url,
            dependency,
            async () =>
              new Response(
                "<package><metadata><id>Confeature.Client</id><version>0.4.0</version></metadata></package>",
              ),
          );
        },
      }),
    ).resolves.toMatchObject({ coordinates: "Confeature.OpenFeature", version: "1.2.3" });
  });
  it("an after dependency on a registry it cannot check", () => {
    const root = fixture(
      [
        unit({ after: ["b"] }),
        unit({
          name: "b",
          gate: "b",
          registry: "pypi",
          versionSource: { file: "b/v.txt", pattern: "^version=(\\S+)$" },
        }),
      ],
      [covered(), covered("b")],
      base,
    );
    return refused(root, { tag: "sdk-a-v1.2.3" }, /cannot check "b"/);
  });
  it("requires the exact packaged Ruby dependency on RubyGems", async () => {
    const gemspec = "apps/sdk-ruby-openfeature/confeature-openfeature.gemspec";
    const root = fixture(
      [
        unit({
          name: "openfeature-ruby",
          registry: "rubygems",
          coordinates: "confeature-openfeature",
          after: ["b"],
        }),
        unit({
          name: "b",
          registry: "rubygems",
          coordinates: "confeature",
          versionSource: { file: "b/v.txt", pattern: "^version=(\\S+)$" },
        }),
      ],
      [covered()],
      { ...base, [gemspec]: '  spec.add_dependency "confeature", "= 0.2.0"\n' },
    );
    const options = { root, tag: "sdk-openfeature-ruby-v1.2.3", ...MAIN };
    const url = "https://rubygems.org/api/v2/rubygems/confeature/versions/0.2.0.json?platform=ruby";
    const gem = {
      name: "confeature",
      version: "0.2.0",
      platform: "ruby",
      yanked: false,
      sha: "a".repeat(64),
    };
    await expect(
      resolvePublish({
        ...options,
        exists: async (target, identity) => {
          expect(target).toBe(url);
          return httpExists(target, identity, async (requested, request) => {
            expect(requested).toBe(url);
            expect(request).toEqual({
              method: "GET",
              headers: { accept: "application/json" },
              redirect: "error",
            });
            return Response.json(gem);
          });
        },
      }),
    ).resolves.toMatchObject({ coordinates: "confeature-openfeature" });
    await expect(resolvePublish({ ...options, exists: unpublished })).rejects.toThrow(
      /confeature@0\.2\.0, which is not published yet/,
    );
    for (const metadata of [
      { ...gem, version: "0.4.0" },
      { ...gem, name: "unrelated" },
      { ...gem, platform: "java" },
      { ...gem, yanked: true },
      { ...gem, sha: "invalid" },
    ]) {
      await expect(
        httpExists(
          url,
          { coordinates: gem.name, registry: "rubygems", version: gem.version },
          async () => Response.json(metadata),
        ),
      ).rejects.toThrow(/expected active Ruby gem/);
    }

    writeFileSync(join(root, gemspec), '  spec.add_dependency "confeature", "~> 0.2.0"\n');
    await expect(resolvePublish({ ...options, exists: published })).rejects.toThrow(
      /pin one exact confeature gem version/,
    );
  });
  it("a commit that is not on main", () =>
    refused(
      fixture([unit()], [covered()], base),
      { tag: "sdk-a-v1.2.3", mainRef: "origin/main", isOnMain: () => false },
      /not on origin\/main/,
    ));
  it("a dry run of a tag-versioned unit without --version", () =>
    refused(
      fixture([unit({ versionSource: "tag" })], [covered()], {}),
      { unit: "a" },
      /needs --version/,
    ));
  // A workflow_dispatch input reaches the outputs, and through them the pack
  // job's paths and the mirror tag: it is held to the tag's semver, not only to
  // the safe character set (#794 review: `1.0.0/../x` and `{x}` passed).
  it.each(["1.0.0/../x", "{x}", "1.0", "v1.0.0", "1.0.0+build", "01.0.0", ""])(
    "a dry-run --version that is not semver (%j)",
    (version) =>
      refused(
        fixture([unit({ versionSource: "tag" })], [covered()], {}),
        { unit: "a", version },
        /--version .* is not semver/,
      ),
  );
  it("a dry-run --version that is semver is the version", async () => {
    const root = fixture([unit({ versionSource: "tag" })], [covered()], {});
    expect((await resolvePublish({ root, unit: "a", version: "1.2.3-rc.1" })).version).toBe(
      "1.2.3-rc.1",
    );
  });
  it("unsafe characters in an emitted value", () =>
    refused(
      fixture([unit({ coordinates: "@x/a;rm -rf" })], [covered()], base),
      { tag: "sdk-a-v1.2.3" },
      /unsafe characters/,
    ));
  it("both --tag and --unit, or neither", async () => {
    const root = fixture([unit()], [covered()], base);
    await expect(resolvePublish({ root })).rejects.toBeInstanceOf(Refusal);
    await expect(resolvePublish({ root, tag: "sdk-a-v1.2.3", unit: "a" })).rejects.toBeInstanceOf(
      Refusal,
    );
  });
  // Both reach `git merge-base` as arguments: a value starting with `-` would
  // be read as an option, never as a revision (#794 review).
  it.each([
    ["--commit", { commit: "--help" }],
    ["--main-ref", { mainRef: "--upload-pack=x" }],
  ])("a %s value that starts with -", (_, over) => {
    let called = false;
    return refused(
      fixture([unit()], [covered()], base),
      { tag: "sdk-a-v1.2.3", ...MAIN, isOnMain: () => (called = true), ...over },
      /starts with -/,
    ).then(() => expect(called).toBe(false));
  });
  it("a release tag without --main-ref", () =>
    expect(
      resolvePublish({
        root: fixture([unit()], [covered()], base),
        tag: "sdk-a-v1.2.3",
        exists: published,
      }),
    ).rejects.toThrow(/needs --main-ref/));
  it("an unreadable manifest is an input error", () => {
    const root = fixture([unit()], [covered()], base);
    writeFileSync(join(root, MANIFEST), "{ not json");
    return expect(resolvePublish({ root, tag: "sdk-a-v1.2.3", ...MAIN })).rejects.toBeInstanceOf(
      InputError,
    );
  });
  it("an empty publish table", () =>
    refused(
      fixture([], [covered()], base),
      { tag: "sdk-a-v1.2.3" },
      /publish\[\] is missing or empty/,
    ));
});

describe("the CLI", () => {
  const cli = (...args) =>
    spawnSync(process.execPath, [join(ROOT, "tools/sdk-pack/resolve-publish.mjs"), ...args], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, GITHUB_OUTPUT: "" },
    });
  it("maps every flag explicitly", () =>
    expect(parseArgs(["--tag", "t", "--main-ref", "m", "--commit", "c"])).toEqual({
      tag: "t",
      mainRef: "m",
      commit: "c",
    }));
  it("refuses an unknown or repeated flag as a usage error", () => {
    expect(() => parseArgs(["--mainref", "m"])).toThrow(InputError);
    expect(() => parseArgs(["--tag", "a", "--tag", "b"])).toThrow(InputError);
  });
  it("--main-ref reaches the git ancestry check (an unknown ref is refused, exit 1)", () => {
    const r = cli("--tag", PYTHON_TAG, "--main-ref", "refs/does/not/exist");
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/could not compare/);
  });
  it("a tag on main is accepted (HEAD is its own ancestor)", () => {
    const r = cli("--tag", PYTHON_TAG, "--commit", "HEAD", "--main-ref", "HEAD");
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({
      name: "python",
      registry: "pypi",
      version: PYTHON_VERSION,
    });
  });
  it("a tag without --main-ref is refused, exit 1", () => {
    const r = cli("--tag", PYTHON_TAG);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/needs --main-ref/);
  });
  it("a usage error is exit 2", () => expect(cli("--nope", "x").status).toBe(2));
});

describe("OUTPUT_KEYS is exactly what the resolver emits (round 7)", () => {
  it("every accepted unit's outputs are OUTPUT_KEYS, in order", async () => {
    const out = await resolvePublish({ root: ROOT, unit: "node" });
    expect(Object.keys(out)).toEqual([...OUTPUT_KEYS]);
  });
  it("checkSafe refuses to emit any other set: one missing, one extra, reordered", () => {
    const ok = Object.fromEntries(OUTPUT_KEYS.map((k) => [k, "x"]));
    expect(() => checkSafe(ok)).not.toThrow();
    const { path: _p, ...missing } = ok;
    expect(() => checkSafe(missing)).toThrow(/not OUTPUT_KEYS/);
    expect(() => checkSafe({ ...ok, extra: "x" })).toThrow(/not OUTPUT_KEYS/);
    const [first, ...rest] = OUTPUT_KEYS;
    expect(() => checkSafe(Object.fromEntries([...rest, first].map((k) => [k, "x"])))).toThrow(
      /not OUTPUT_KEYS/,
    );
  });
});
