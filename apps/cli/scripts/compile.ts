// SPDX-License-Identifier: MIT

/**
 * Cross-platform build (FR-009, C18, SC-006; distribution slice #657 / spec 183).
 *
 * Runs `deno compile --target <t>` for every supported desktop target, emitting
 * standalone binaries under `dist/` with the STABLE, documented asset names
 * `confeature-<target>` (`.exe` for the Windows target). The release workflow
 * (`.github/workflows/cli-release.yml`) publishes exactly these names — plus a
 * `SHA256SUMS` manifest — to https://cli.confeature.io/v<version>/ (R2, #801)
 * and mirrors them on the GitHub Release; `install.sh` / `install.ps1` download
 * them by name. `dist/` is git-ignored.
 *
 * The five asset names are the install/release contract — do not rename them
 * without updating the installers, the workflow, and the docs in lockstep.
 *
 * Usage:
 *   deno task compile            # all five targets
 *   deno task compile --host     # only the host target (fast local verification)
 *
 * `--host` exists because cross-target compiles download a per-target runtime
 * (slow / network-heavy); the smoke check only needs the host binary to run
 * (SC-006: "at least the host binary verified to run").
 *
 * The shipped binary is compiled with **least-privilege** Deno permissions
 * (review HIGH: never `-A` in a distributed binary) — only the capabilities the
 * CLI actually uses: the config + credential files (read/write), the env vars
 * it reads, network (the management API), and process spawn (the browser
 * opener for `confeature login`, #654).
 */

import { join } from "@std/path";

import { openerOf } from "../src/cli/browser.ts";

/**
 * Least-privilege grants baked into the shipped binary.
 *
 *   - `--allow-read` / `--allow-write` — the config + credential files.
 *   - `--allow-env=…` — restricted to the exact variables `config/paths.ts` and
 *     `config/resolve.ts` read.
 *   - `--allow-net` — the management API (`login` / `whoami` / `logout`). It is
 *     intentionally UNSCOPED: the API base URL is runtime-configurable
 *     (`--api-url` / `CONFEATURE_API_URL` / a profile) so the binary must reach
 *     any self-host or hosted deployment; a compile-time host allow-list would
 *     break self-host. The URL is still validated to an absolute http(s) URL at
 *     resolve time (`config/resolve.ts`).
 *   - `--allow-run=<opener>` — only the target's own browser opener
 *     (`openerOf` in `cli/browser.ts`): `open`, `xdg-open` or `cmd`. Granting all
 *     three made Deno print an "Info Failed to resolve …" line for each opener
 *     the platform lacks, before every command's output (#904). Never an open
 *     `--allow-run`.
 *
 * Never `-A`.
 */
const PERMISSIONS = [
  "--allow-read",
  "--allow-write",
  "--allow-env=XDG_CONFIG_HOME,HOME,APPDATA,USERPROFILE,CONFEATURE_API_URL,CONFEATURE_PROFILE",
  "--allow-net",
];

/** The OS a Rust target triple names, as `Deno.build.os` spells it. */
function osOf(target: string): string {
  if (target.includes("apple-darwin")) return "darwin";
  if (target.includes("windows")) return "windows";
  return "linux";
}

/** The grants baked into the binary for `target`: the shared set plus its one opener. */
export function permissionsFor(target: string): string[] {
  return [...PERMISSIONS, `--allow-run=${openerOf(osOf(target))}`];
}

/** The five desktop targets Confeature ships (plan.md / research.md R5). */
const TARGETS = [
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "x86_64-unknown-linux-gnu",
  "aarch64-unknown-linux-gnu",
  "x86_64-pc-windows-msvc",
] as const;

/**
 * Release assets land directly in `dist/` (not `dist/bin/`) so the workflow can
 * address them as `apps/cli/dist/confeature-*` and the `SHA256SUMS` manifest
 * sits beside them.
 */
const OUT_DIR = join(import.meta.dirname!, "..", "dist");
const ENTRY = join(import.meta.dirname!, "..", "src", "main.ts");

/** Stable, documented asset name for a target (`.exe` on Windows). */
export function assetName(target: string): string {
  const ext = target.includes("windows") ? ".exe" : "";
  return `confeature-${target}${ext}`;
}

function outputPath(target: string): string {
  return join(OUT_DIR, assetName(target));
}

async function compile(target: string): Promise<boolean> {
  const out = outputPath(target);
  console.log(`• compiling ${target} → ${out}`);
  const cmd = new Deno.Command("deno", {
    args: ["compile", ...permissionsFor(target), "--target", target, "--output", out, ENTRY],
    stdout: "inherit",
    stderr: "inherit",
  });
  const { success } = await cmd.output();
  if (!success) console.error(`✗ ${target} failed`);
  return success;
}

async function main(): Promise<void> {
  await Deno.mkdir(OUT_DIR, { recursive: true });
  const hostOnly = Deno.args.includes("--host");
  const targets = hostOnly ? [Deno.build.target] : TARGETS;

  let ok = true;
  for (const target of targets) {
    ok = (await compile(target)) && ok;
  }

  if (!ok) {
    console.error("compile: one or more targets failed");
    Deno.exit(1);
  }
  console.log(`✓ compiled ${targets.length} target(s) into ${OUT_DIR}`);
}

if (import.meta.main) {
  await main();
}
