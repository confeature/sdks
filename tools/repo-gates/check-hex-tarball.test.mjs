// SPDX-License-Identifier: MIT

// The Hex package check (tools/sdk-pack/check-hex-tarball.sh, #909): a package
// shaped as `mix hex.build` writes it is accepted, and each refusal is seen to
// fail closed on its own.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(ROOT, "tools/sdk-pack/check-hex-tarball.sh");

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** metadata.config as hex_tarball writes it: one top-level term per entry. */
const metadata = ({ name = "confeature_client", app = name, version = "0.1.0", extra = "" } = {}) =>
  `{<<"links">>,[{<<"GitHub">>,<<"https://github.com/confeature/sdks">>}]}.
{<<"name">>,<<"${name}">>}.
{<<"version">>,<<"${version}">>}.
{<<"app">>,<<"${app}">>}.
{<<"requirements">>,
 [[{<<"name">>,<<"jason">>},
   {<<"app">>,<<"jason">>},
   {<<"requirement">>,<<"~> 1.4">>}]]}.
${extra}`;

/** A package at `<dir>/<file>`, the outer tar holding `entries` (name → body). */
function pkg(file, entries) {
  const d = mkdtempSync(join(tmpdir(), "hex-tarball-"));
  dirs.push(d);
  const src = join(d, "src");
  mkdirSync(src);
  for (const [n, body] of Object.entries(entries)) writeFileSync(join(src, n), body);
  const out = join(d, file);
  const r = spawnSync("tar", ["-cf", out, "-C", src, ...Object.keys(entries)], {
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(r.stderr);
  return out;
}
const GOOD = (meta = metadata()) => ({
  VERSION: "3",
  CHECKSUM: "abc",
  "metadata.config": meta,
  "contents.tar.gz": "gz",
});
const check = (file, name = "confeature_client", version = "0.1.0") =>
  spawnSync("bash", [SCRIPT, file, name, version], { encoding: "utf8" });

describe("check-hex-tarball.sh", () => {
  it("accepts a package of the resolved unit", () => {
    const r = check(pkg("confeature_client-0.1.0.tar", GOOD()));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/is confeature_client 0\.1\.0/);
  });

  it.each([
    ["another file name", "confeature_client-0.2.0.tar", GOOD(), /is not named/],
    [
      "another version in the metadata",
      "confeature_client-0.1.0.tar",
      GOOD(metadata({ version: "0.2.0" })),
      /version 0\.1\.0 exactly once/,
    ],
    [
      "another name in the metadata",
      "confeature_client-0.1.0.tar",
      GOOD(metadata({ name: "other" })),
      /name confeature_client exactly once/,
    ],
    [
      "another app",
      "confeature_client-0.1.0.tar",
      GOOD(metadata({ app: "other" })),
      /app confeature_client exactly once/,
    ],
    [
      "a second top-level version",
      "confeature_client-0.1.0.tar",
      GOOD(metadata({ extra: '{<<"version">>,<<"9.9.9">>}.\n' })),
      /declares version more than once/,
    ],
    [
      "another tarball format",
      "confeature_client-0.1.0.tar",
      { ...GOOD(), VERSION: "2" },
      /tarball format 3/,
    ],
    [
      "an extra entry",
      "confeature_client-0.1.0.tar",
      { ...GOOD(), "evil.sh": "x" },
      /not exactly VERSION, CHECKSUM/,
    ],
  ])("refuses %s", (_, file, entries, why) => {
    const r = check(pkg(file, entries));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(why);
  });

  it("is a usage error without its three arguments, and on a missing file", () => {
    expect(spawnSync("bash", [SCRIPT, "x.tar"], { encoding: "utf8" }).status).toBe(2);
    expect(check("/nonexistent/confeature_client-0.1.0.tar").status).toBe(2);
  });
});
