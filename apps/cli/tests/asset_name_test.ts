// SPDX-License-Identifier: MIT

import { assertEquals } from "@std/assert";
import { assetName } from "../scripts/compile.ts";

// FR-009 / SC-006 — the release/install asset-name contract.
//
// `assetName` is the single source of truth that ties together three files:
// the workflow's `gh release upload apps/cli/dist/confeature-*`, the installers'
// `confeature-<target>` download names (install.sh / install.ps1), and the docs
// table (held to the same host by the private site's own test, #858). Pin the mapping so a rename can't silently 404 the documented installer.

const EXPECTED: Record<string, string> = {
  "aarch64-apple-darwin": "confeature-aarch64-apple-darwin",
  "x86_64-apple-darwin": "confeature-x86_64-apple-darwin",
  "x86_64-unknown-linux-gnu": "confeature-x86_64-unknown-linux-gnu",
  "aarch64-unknown-linux-gnu": "confeature-aarch64-unknown-linux-gnu",
  "x86_64-pc-windows-msvc": "confeature-x86_64-pc-windows-msvc.exe",
};

Deno.test("assetName maps each of the five targets to its documented name", () => {
  for (const [target, name] of Object.entries(EXPECTED)) {
    assertEquals(assetName(target), name);
  }
});

Deno.test("assetName appends .exe only for the Windows target", () => {
  assertEquals(assetName("x86_64-pc-windows-msvc"), "confeature-x86_64-pc-windows-msvc.exe");
  // Non-Windows targets never get the suffix.
  assertEquals(assetName("aarch64-apple-darwin").endsWith(".exe"), false);
  assertEquals(assetName("x86_64-unknown-linux-gnu").endsWith(".exe"), false);
});

// ---------------------------------------------------------------------------
// #801 — the install host is ONE decision, spelled in two shells. This binds
// every public copy to it: the installers, the writer and the release
// workflows. The docs and landing pages are private, so their half is the
// sites' install-page check, which stays private (#858).
// ---------------------------------------------------------------------------

const INSTALL_BASE_URL = "https://cli.confeature.io";
const ROOT = new URL("../../../", import.meta.url);
const read = (path: string) => Deno.readTextFileSync(new URL(path, ROOT));

const SCRIPTS = ["apps/cli/install.sh", "apps/cli/install.ps1"];

// Every file that names the host at all: a literal anywhere must BE the host —
// a second, drifted spelling in a workflow or the writer is what the plan's
// decision table forbids (#801 review).
const HOST_NAMING = [
  ...SCRIPTS,
  "apps/cli/scripts/publish-r2.sh",
  ".github/workflows/cli-release.yml",
  ".github/workflows/cli-windows-install-verify.yml",
];

Deno.test("every cli.* host literal in the scripts, workflows and writer is the one host", () => {
  for (const file of HOST_NAMING) {
    for (const [literal] of read(file).matchAll(/https?:\/\/cli\.[A-Za-z0-9.-]+/g)) {
      assertEquals(literal, INSTALL_BASE_URL, `${file}: ${literal}`);
    }
  }
});

Deno.test("both installers declare the one install host", () => {
  assertEquals(read("apps/cli/install.sh").includes(`BASE_URL="${INSTALL_BASE_URL}"`), true);
  assertEquals(read("apps/cli/install.ps1").includes(`$BaseUrl = "${INSTALL_BASE_URL}"`), true);
});

// An installer that downloads from GitHub instead of the host 404s for every
// outside user. No GitHub URL at all, and no variable to build one.
Deno.test("no installer downloads from GitHub", () => {
  for (const file of SCRIPTS) {
    const text = read(file);
    assertEquals(/github\.com/i.test(text), false, `${file} names GitHub`);
    assertEquals(/\bREPO=|\$Repo\b/.test(text), false, `${file} still builds a GitHub URL`);
  }
});

// ---- SC-005: one strict version check in each script (FR-008) -------------

const VERSIONS: Array<[string, boolean]> = [
  ["0.2.0", true],
  ["10.20.300", true],
  ["0.2.0\n1.0.0", false],
  ["0.2.0\n", false],
  ["٠.2.0", false],
  ["../x", false],
  ["", false],
  ["0.2", false],
  ["0.2.0.1", false],
  ["0..2", false],
  ["$(id)", false],
];

function extract(file: string, start: RegExp): string {
  const text = read(file);
  const from = text.search(start);
  if (from < 0) throw new Error(`${file}: validator not found`);
  const end = text.indexOf("\n}\n", from);
  return text.slice(from, end + 2);
}

for (const file of ["apps/cli/install.sh", "apps/cli/scripts/publish-r2.sh"]) {
  Deno.test(`${file}'s is_version accepts exactly X.Y.Z`, () => {
    const fn = extract(file, /^is_version\(\) \{/m);
    for (const [value, ok] of VERSIONS) {
      const { code } = new Deno.Command("bash", {
        args: ["-c", `${fn}\nis_version "$V"`],
        env: { V: value },
      }).outputSync();
      assertEquals(code === 0, ok, `${file}: ${JSON.stringify(value)}`);
    }
  });
}

Deno.test("install.sh's is_version also holds under POSIX sh", () => {
  const fn = extract("apps/cli/install.sh", /^is_version\(\) \{/m);
  for (const [value, ok] of VERSIONS) {
    const { code } = new Deno.Command("sh", {
      args: ["-c", `${fn}\nis_version "$V"`],
      env: { V: value },
    }).outputSync();
    assertEquals(code === 0, ok, JSON.stringify(value));
  }
});

const hasPwsh = (() => {
  try {
    return new Deno.Command("pwsh", { args: ["-v"] }).outputSync().success;
  } catch {
    return false;
  }
})();

Deno.test({
  name: `install.ps1's Test-Version accepts exactly X.Y.Z${hasPwsh ? "" : " (SKIPPED: no pwsh)"}`,
  ignore: !hasPwsh,
  fn() {
    const fn = extract("apps/cli/install.ps1", /^function Test-Version/m);
    for (const [value, ok] of VERSIONS) {
      const { stdout } = new Deno.Command("pwsh", {
        args: ["-NoProfile", "-Command", `${fn}\nTest-Version $env:V`],
        env: { V: value },
      }).outputSync();
      assertEquals(
        new TextDecoder().decode(stdout).trim(),
        ok ? "True" : "False",
        JSON.stringify(value),
      );
    }
  },
});
