// SPDX-License-Identifier: MIT

// The publish-tag resolver (tools/sdk-pack/resolve-publish.mjs). Two halves:
// - the REAL manifest: every unit resolves or is refused for its declared reason;
// - a fixture manifest: one case per refusal, so each rule is seen to fail closed.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  InputError,
  MANIFEST,
  OUTPUT_KEYS,
  checkSafe,
  Refusal,
  parseArgs,
  resolvePublish,
  tagRegex,
} from "../sdk-pack/resolve-publish.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REAL = JSON.parse(readFileSync(join(ROOT, MANIFEST), "utf8"));
const published = async () => true;
const MAIN = { mainRef: "origin/main", isOnMain: () => true };
const unpublished = async () => false;

describe("the real publish table", () => {
  it("has exactly one unit per roster entry, plus shared", () => {
    const byName = (a, b) => a.localeCompare(b);
    const units = REAL.publish.map((u) => u.name).sort(byName);
    const expected = [...REAL.sdks.map((s) => s.name), "shared"].sort(byName);
    expect(units).toEqual(expected);
  });

  it.each(REAL.publish.map((u) => [u.name, u]))(
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

  it("a release tag carries the declared version, never a substring of the tag", async () => {
    const out = await resolvePublish({
      root: ROOT,
      tag: "sdk-python-v0.1.0",
      exists: published,
      ...MAIN,
    });
    expect(out).toMatchObject({
      name: "python",
      registry: "pypi",
      gate: "test",
      daggerFn: "python-test",
    });
  });

  it("Go's release tag and the mirrors' tags are filled from the unit", async () => {
    expect((await resolvePublish({ root: ROOT, tag: "sdk-go-v0.1.0", ...MAIN })).releaseTag).toBe(
      "apps/sdk-go/v0.1.0",
    );
    const php = await resolvePublish({ root: ROOT, tag: "sdk-php-v0.1.0", ...MAIN });
    expect(php).toMatchObject({
      mirrorRepository: "confeature/confeature-php-sdk",
      mirrorTag: "v0.1.0",
    });
  });
});

describe("tagFormat", () => {
  const re = tagRegex("sdk-{name}-v{version}");
  it.each([
    ["sdk-node-v0.1.0", "node", "0.1.0"],
    ["sdk-kotlin-mp-v1.20.3", "kotlin-mp", "1.20.3"],
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
function fixture(publish, sdks, files = {}) {
  const root = mkdtempSync(join(tmpdir(), "resolve-publish-"));
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
    const r = cli("--tag", "sdk-python-v0.1.0", "--main-ref", "refs/does/not/exist");
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/could not compare/);
  });
  it("a tag on main is accepted (HEAD is its own ancestor)", () => {
    const r = cli("--tag", "sdk-python-v0.1.0", "--commit", "HEAD", "--main-ref", "HEAD");
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ name: "python", registry: "pypi" });
  });
  it("a tag without --main-ref is refused, exit 1", () =>
    expect(cli("--tag", "sdk-python-v0.1.0").status).toBe(1));
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
