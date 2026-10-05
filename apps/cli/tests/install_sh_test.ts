// SPDX-License-Identifier: MIT

import { assertEquals, assertStringIncludes } from "@std/assert";
import { assetName } from "../scripts/compile.ts";

// install.sh run END TO END (#801 review) against a stub host: a stub `curl`
// serves a directory, `HOME` is a temp dir. It is the script users pipe into a
// shell, so every way it could install the wrong thing — a bad `latest`, a
// tampered binary, a manifest with no line for this host — must abort and
// install NOTHING. The one success path installs.

const SCRIPT = new URL("../install.sh", import.meta.url).pathname;
const TARGETS = [
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "x86_64-unknown-linux-gnu",
  "aarch64-unknown-linux-gnu",
];

const CURL_STUB = `#!/usr/bin/env bash
url=""; out=""; max=""
while [ $# -gt 0 ]; do case "$1" in
  -o) out="$2"; shift 2;; --max-filesize) max="$2"; shift 2;;
  --proto) shift 2;; http*) url="$1"; shift;; *) shift;; esac; done
echo "$url max=$max" >> "$HOST_DIR/../curl.log"
path="$HOST_DIR/\${url#https://*/}"
[ -f "$path" ] || exit 22
if [ -n "$max" ] && [ "$(wc -c < "$path")" -gt "$max" ]; then exit 63; fi
if [ -n "$out" ]; then cp "$path" "$out"; else cat "$path"; fi
`;

async function sha256(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface Host {
  host: string;
  home: string;
  env: Record<string, string>;
}

/** A published v0.2.0 for every non-Windows target, and `latest` as given (or none). */
async function host(latest: string | null): Promise<Host> {
  const dir = Deno.makeTempDirSync({ prefix: "install-sh-" });
  const bin = `${dir}/bin`;
  const hostDir = `${dir}/host`;
  const home = `${dir}/home`;
  for (const d of [bin, `${hostDir}/v0.2.0`, `${home}/.local/bin`]) {
    Deno.mkdirSync(d, { recursive: true });
  }
  Deno.writeTextFileSync(`${bin}/curl`, CURL_STUB, { mode: 0o755 });
  const sums: string[] = [];
  for (const t of TARGETS) {
    const name = assetName(t);
    const body = new TextEncoder().encode(`binary for ${t}`);
    Deno.writeFileSync(`${hostDir}/v0.2.0/${name}`, body);
    sums.push(`${await sha256(body)}  ${name}`);
  }
  Deno.writeTextFileSync(`${hostDir}/v0.2.0/SHA256SUMS`, sums.join("\n") + "\n");
  if (latest !== null) Deno.writeTextFileSync(`${hostDir}/latest`, latest);
  // A non-X.Y.Z version that IS served: only the validator stands between it
  // and an install (the other bad values would also fail on the download).
  Deno.mkdirSync(`${hostDir}/v0.2.0-evil`);
  for (const f of Deno.readDirSync(`${hostDir}/v0.2.0`)) {
    Deno.copyFileSync(`${hostDir}/v0.2.0/${f.name}`, `${hostDir}/v0.2.0-evil/${f.name}`);
  }
  return {
    host: hostDir,
    home,
    env: { PATH: `${bin}:${Deno.env.get("PATH")}`, HOST_DIR: hostDir, HOME: home },
  };
}

function install(h: Host, ...args: string[]) {
  const { code, stdout, stderr } = new Deno.Command("sh", {
    args: [SCRIPT, ...args],
    env: h.env,
  }).outputSync();
  const dec = new TextDecoder();
  return { code, out: dec.decode(stdout) + dec.decode(stderr) };
}

const installed = (h: Host) => {
  try {
    Deno.statSync(`${h.home}/.local/bin/confeature`);
    return true;
  } catch {
    return false;
  }
};

Deno.test("installs latest when latest is exactly X.Y.Z", async () => {
  const h = await host("0.2.0");
  const r = install(h);
  assertEquals(r.code, 0, r.out);
  assertStringIncludes(r.out, "checksum verified");
  assertEquals(installed(h), true);
});

Deno.test("a CRLF-terminated latest still installs (\\r is stripped)", async () => {
  const h = await host("0.2.0\r\n");
  assertEquals(install(h).code, 0);
  assertEquals(installed(h), true);
});

Deno.test("a pinned version installs without reading latest", async () => {
  const h = await host(null);
  assertEquals(install(h, "--version", "0.2.0").code, 0);
  assertEquals(installed(h), true);
});

for (
  const [label, latest] of [
    ["a missing latest", null],
    ["an empty latest", ""],
    ["an HTML error page as latest", "<html>"],
    ["an oversized latest", "0.2.0" + " ".repeat(64)],
    ["a two-line latest", "0.2.0\n1.0.0"],
    ["a path in latest", "../../etc"],
    ["a served but non-X.Y.Z latest", "0.2.0-evil"],
  ] as const
) {
  Deno.test(`${label} aborts and installs nothing`, async () => {
    const h = await host(latest);
    const r = install(h);
    assertEquals(r.code !== 0, true, r.out);
    assertEquals(installed(h), false);
  });
}

Deno.test("a tampered binary aborts on the checksum and installs nothing", async () => {
  const h = await host("0.2.0");
  for (const t of TARGETS) Deno.writeTextFileSync(`${h.host}/v0.2.0/${assetName(t)}`, "tampered");
  const r = install(h);
  assertEquals(r.code !== 0, true);
  assertStringIncludes(r.out, "checksum mismatch");
  assertEquals(installed(h), false);
});

Deno.test("a manifest with no line for this host aborts and installs nothing", async () => {
  const h = await host("0.2.0");
  Deno.writeTextFileSync(`${h.host}/v0.2.0/SHA256SUMS`, "deadbeef  some-other-asset\n");
  const r = install(h);
  assertEquals(r.code !== 0, true);
  assertStringIncludes(r.out, "no checksum for");
  assertEquals(installed(h), false);
});

Deno.test("a missing binary aborts and installs nothing", async () => {
  const h = await host("0.2.0");
  for (const t of TARGETS) Deno.removeSync(`${h.host}/v0.2.0/${assetName(t)}`);
  assertEquals(install(h).code !== 0, true);
  assertEquals(installed(h), false);
});

Deno.test("latest is fetched with a 32-byte cap", async () => {
  const h = await host("0.2.0");
  install(h);
  const log = Deno.readTextFileSync(`${h.host}/../curl.log`);
  const line = log.split("\n").find((l) => l.includes("/latest"));
  assertEquals(line?.endsWith("max=32"), true, log);
});
