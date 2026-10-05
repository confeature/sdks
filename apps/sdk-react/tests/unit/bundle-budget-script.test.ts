// SPDX-License-Identifier: MIT

/**
 * #800 — the React-layer budget is measured against the built sdk-browser-js,
 * never against a hardcoded baseline (which went stale when browser-js shrank
 * and silently turned this budget off). Runs the real check script over a
 * synthetic `apps/` layout.
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, expect, test } from "vite-plus/test";

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "scripts",
  "check-bundle-size.mjs",
);
const roots: string[] = [];
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

/** A browser-js bundle, and a react bundle = it + `layerBytes` of incompressible layer. */
function layout(layerBytes: number) {
  const root = mkdtempSync(join(tmpdir(), "react-budget-"));
  roots.push(root);
  const browserJs = Buffer.from("export const engine = 1;\n".repeat(400));
  const layer = Buffer.from(
    `export const layer = "${randomBytes(layerBytes).toString("base64")}";\n`,
  );
  for (const dir of ["sdk-react/scripts", "sdk-react/dist", "sdk-browser-js/dist"]) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  copyFileSync(SCRIPT, join(root, "sdk-react/scripts/check-bundle-size.mjs"));
  writeFileSync(join(root, "sdk-browser-js/dist/index.mjs"), browserJs);
  writeFileSync(join(root, "sdk-react/dist/index.mjs"), Buffer.concat([browserJs, layer]));
  return join(root, "sdk-react/scripts/check-bundle-size.mjs");
}

const run = (script: string) => spawnSync(process.execPath, [script], { encoding: "utf8" });

test("a small React layer passes", () => {
  const r = run(layout(1024));
  expect(r.status).toBe(0);
});

test("a React layer 6 KB larger fails, however small the total", () => {
  const r = run(layout(6 * 1024));
  expect(r.status).toBe(1);
  expect(r.stderr + r.stdout).toContain("React layer");
});

test("without a built sdk-browser-js the check fails rather than guessing", () => {
  const script = layout(1024);
  rmSync(join(dirname(script), "..", "..", "sdk-browser-js"), { recursive: true });
  const r = run(script);
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("build @confeature/sdk-browser-js first");
  expect(r.stderr).toContain("ENOENT");
});

test("a React bundle smaller than the browser-js it should embed fails, never clamps to 0", () => {
  const script = layout(1024);
  writeFileSync(join(dirname(script), "..", "dist", "index.mjs"), "export const tiny = 1;\n");
  const r = run(script);
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("smaller than the sdk-browser-js bundle");
});
