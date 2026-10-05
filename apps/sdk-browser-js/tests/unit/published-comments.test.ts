// SPDX-License-Identifier: MIT

/**
 * #800 — the published JS ships without JSDoc, but keeps legal comments and
 * pure annotations. Packs a fixture with the shared setting every SDK uses
 * (`tools/sdk-pack/comments.mjs`), so the guarantee does not depend on a
 * `dist/` someone happened to build.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "vite-plus/pack";
import { afterAll, expect, test } from "vite-plus/test";

import { PUBLISHED_COMMENTS } from "../../../../tools/sdk-pack/comments.mjs";

const dir = mkdtempSync(join(tmpdir(), "published-comments-"));
const APPS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("JSDoc leaves the JS; @license, /*! and @__PURE__ stay", async () => {
  writeFileSync(
    join(dir, "index.ts"),
    [
      "/** @license Fixture-Licence-1.0 — a legal notice */",
      "/*! keep this banner */",
      "function make(): number[] { return [1]; }",
      "/** Documented for editors, not for the bundle. */",
      "export function documented(): number { return 1; }",
      "export const made = /* @__PURE__ */ make();",
      "",
    ].join("\n"),
  );
  await build({
    config: false,
    entry: [join(dir, "index.ts")],
    outDir: join(dir, "dist"),
    format: ["esm"],
    dts: false,
    logLevel: "silent",
    outputOptions: { comments: PUBLISHED_COMMENTS },
  });
  const out = readdirSync(join(dir, "dist")).find((f) => f.endsWith(".mjs"));
  expect(out).toBeDefined();
  const js = readFileSync(join(dir, "dist", out!), "utf8");
  expect(js).toContain("@license Fixture-Licence-1.0");
  expect(js).toContain("keep this banner");
  expect(js).toMatch(/[@#]__PURE__/);
  expect(js).not.toContain("Documented for editors");
});

test.each(["browser-js", "bun", "deno", "react", "cloudflare-worker", "node"])(
  "sdk-%s's pack applies the shared setting",
  (sdk) => {
    const config = readFileSync(join(APPS, `sdk-${sdk}`, "vite.config.ts"), "utf8");
    expect(config).toContain('from "../../tools/sdk-pack/comments.mjs"');
    expect(config).toMatch(/outputOptions:\s*\{\s*comments:\s*PUBLISHED_COMMENTS\s*\}/);
  },
);
