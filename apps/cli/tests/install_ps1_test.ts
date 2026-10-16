// SPDX-License-Identifier: MIT

import { assertEquals, assertStringIncludes } from "@std/assert";

// install.ps1 run END TO END under pwsh (#801 review) against a stub host: a
// stub `Invoke-WebRequest` (a function shadows the cmdlet inside the script)
// serves a directory, `LOCALAPPDATA` is a temp dir. Every way it could install
// the wrong thing must abort and install NOTHING — tested here, before any
// release promotes it, not only on a Windows runner after the fact. Skipped,
// visibly, where no pwsh is installed.

const SCRIPT = new URL("../install.ps1", import.meta.url).pathname;
const ASSET = "confeature-x86_64-pc-windows-msvc.exe";

const hasPwsh = (() => {
  try {
    return new Deno.Command("pwsh", { args: ["-v"] }).outputSync().success;
  } catch {
    return false;
  }
})();

const STUB = `
function Invoke-WebRequest {
  param([string]$Uri, [string]$OutFile, [switch]$UseBasicParsing)
  $path = Join-Path $env:HOST_DIR ($Uri -replace '^https://[^/]+/', '')
  if (-not (Test-Path -LiteralPath $path)) { throw "404 Not Found: $Uri" }
  if ($OutFile) { Copy-Item -LiteralPath $path -Destination $OutFile; return }
  [pscustomobject]@{ Content = [System.IO.File]::ReadAllBytes($path) }
}
`;

async function sha256(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function host(latest: string | null) {
  const dir = Deno.makeTempDirSync({ prefix: "install-ps1-" });
  const hostDir = `${dir}/host`;
  const appData = `${dir}/appdata`;
  Deno.mkdirSync(`${hostDir}/v0.2.0`, { recursive: true });
  Deno.mkdirSync(appData);
  const body = new TextEncoder().encode("windows binary");
  Deno.writeFileSync(`${hostDir}/v0.2.0/${ASSET}`, body);
  Deno.writeTextFileSync(`${hostDir}/v0.2.0/SHA256SUMS`, `${await sha256(body)}  ${ASSET}\n`);
  if (latest !== null) Deno.writeTextFileSync(`${hostDir}/latest`, latest);
  // A non-X.Y.Z version that IS served: only Test-Version stands in the way.
  Deno.mkdirSync(`${hostDir}/v0.2.0-evil`);
  for (const f of Deno.readDirSync(`${hostDir}/v0.2.0`)) {
    Deno.copyFileSync(`${hostDir}/v0.2.0/${f.name}`, `${hostDir}/v0.2.0-evil/${f.name}`);
  }
  return { hostDir, appData };
}

function install(h: { hostDir: string; appData: string }, version = "") {
  const call = version ? `& '${SCRIPT}' -Version ${version}` : `& '${SCRIPT}'`;
  const { code, stdout, stderr } = new Deno.Command("pwsh", {
    args: ["-NoProfile", "-NonInteractive", "-Command", `${STUB}\n${call}`],
    env: { HOST_DIR: h.hostDir, LOCALAPPDATA: h.appData, PROCESSOR_ARCHITECTURE: "AMD64" },
  }).outputSync();
  const dec = new TextDecoder();
  return { code, out: dec.decode(stdout) + dec.decode(stderr) };
}

const installed = (h: { appData: string }) => {
  try {
    Deno.statSync(`${h.appData}/Programs/confeature/confeature.exe`);
    return true;
  } catch {
    return false;
  }
};

const skip = hasPwsh ? "" : " (SKIPPED: no pwsh)";

Deno.test({
  name: `install.ps1 installs latest when latest is exactly X.Y.Z${skip}`,
  ignore: !hasPwsh,
  async fn() {
    const h = await host("0.2.0\r\n");
    const r = install(h);
    assertEquals(r.code, 0, r.out);
    assertStringIncludes(r.out, "checksum verified");
    assertEquals(installed(h), true);
  },
});

for (
  const [label, latest] of [
    ["a missing latest", null],
    ["an HTML error page as latest", "<html>"],
    ["a two-line latest", "0.2.0\n1.0.0"],
    ["a non-ASCII-digit latest", "٠.2.0"],
    ["a served but non-X.Y.Z latest", "0.2.0-evil"],
  ] as const
) {
  Deno.test({
    name: `install.ps1: ${label} aborts and installs nothing${skip}`,
    ignore: !hasPwsh,
    async fn() {
      const h = await host(latest);
      const r = install(h);
      assertEquals(r.code !== 0, true, r.out);
      assertEquals(installed(h), false);
    },
  });
}

Deno.test({
  name: `install.ps1: a tampered binary aborts on the checksum and installs nothing${skip}`,
  ignore: !hasPwsh,
  async fn() {
    const h = await host("0.2.0");
    Deno.writeTextFileSync(`${h.hostDir}/v0.2.0/${ASSET}`, "tampered");
    const r = install(h);
    assertEquals(r.code !== 0, true);
    assertStringIncludes(r.out, "checksum mismatch");
    assertEquals(installed(h), false);
  },
});

Deno.test({
  name: `install.ps1: a manifest with no line for this asset installs nothing${skip}`,
  ignore: !hasPwsh,
  async fn() {
    const h = await host("0.2.0");
    Deno.writeTextFileSync(`${h.hostDir}/v0.2.0/SHA256SUMS`, "deadbeef  other\n");
    const r = install(h);
    assertEquals(r.code !== 0, true);
    assertEquals(installed(h), false);
  },
});

// The verify workflow builds the installer's arguments itself. Run ITS lines,
// not a copy: an array splat (`@("-Version", "X.Y.Z")`) binds by position and
// passed "-Version" as the version, which failed cli-v0.3.2's pinned verify on
// the Windows runner (#898) — a path no release had exercised before.
const VERIFY = new URL("../../../.github/workflows/cli-windows-install-verify.yml", import.meta.url)
  .pathname;
const ARG_BLOCKS = [
  ...Deno.readTextFileSync(VERIFY).matchAll(
    /^[ \t]*\$installArgs = [\s\S]*?(?=^.*& \.\/apps\/cli\/install\.ps1 @installArgs)/gm,
  ),
].map(([block]) => block.split("\n").map((l) => l.trim()).join("\n"));

Deno.test("the verify workflow builds the installer arguments in both install steps", () => {
  assertEquals(ARG_BLOCKS.length, 2);
});

for (const [i, block] of ARG_BLOCKS.entries()) {
  for (const pinned of [true, false]) {
    Deno.test({
      name: `verify workflow install step ${
        i + 1
      } (pinned: ${pinned}) installs the version it names${skip}`,
      ignore: !hasPwsh,
      async fn() {
        // `latest` names a version that is NOT served: a pinned run that
        // ignored its pin, or an unpinned one handed a pin, cannot install.
        const h = await host(pinned ? "0.9.9" : "0.2.0");
        const { code, stdout, stderr } = new Deno.Command("pwsh", {
          args: [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `${STUB}\n${block}\n& '${SCRIPT}' @installArgs`,
          ],
          env: {
            HOST_DIR: h.hostDir,
            LOCALAPPDATA: h.appData,
            PROCESSOR_ARCHITECTURE: "AMD64",
            PINNED: String(pinned),
            VERSION: pinned ? "0.2.0" : "",
          },
        }).outputSync();
        const out = new TextDecoder().decode(stdout) + new TextDecoder().decode(stderr);
        assertEquals(code, 0, out);
        assertStringIncludes(out, "checksum verified");
        assertEquals(installed(h), true);
      },
    });
  }
}
