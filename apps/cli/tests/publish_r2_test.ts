// SPDX-License-Identifier: MIT

import { assertEquals, assertStringIncludes } from "@std/assert";
import { scratchDir } from "./scratch.ts";

// publish-r2.sh (#801) against a fake bucket: a stub `wrangler` writes objects
// into a directory and logs each put, a stub `curl` serves that directory as the
// public host. Every case is a way the only writer could publish something users
// must not get — a changed released version, a half-uploaded `latest`, a
// release's own install scripts.

const SCRIPT = new URL("../scripts/publish-r2.sh", import.meta.url).pathname;
const ROOT = new URL("../../../", import.meta.url).pathname;

const WRANGLER_STUB = `#!/usr/bin/env bash
# r2 object put <bucket>/<key> --file F --content-type T --cache-control C --remote
echo wrangler >> "$CALL_LOG"
# STUB_CWD mimics the real default, \`pnpm --dir … exec wrangler\`, which changes directory.
[ -n "$STUB_CWD" ] && cd "$STUB_CWD"
key="\${4#*/}"; file=""; ct=""; cc=""
shift 4
while [ $# -gt 0 ]; do case "$1" in
  --file) file="$2"; shift 2;; --content-type) ct="$2"; shift 2;;
  --cache-control) cc="$2"; shift 2;; *) shift;; esac; done
[ -n "$FAIL_PUT" ] && [ "$key" = "$FAIL_PUT" ] && exit 1
[ -f "$file" ] || { echo "The file \"$file\" does not exist." >&2; exit 1; }
mkdir -p "$BUCKET_DIR/$(dirname "$key")"
cp "$file" "$BUCKET_DIR/$key"
echo "$key|$ct|$cc" >> "$PUT_LOG"
`;

const AWS_STUB = `#!/usr/bin/env bash
# aws s3api put-object --endpoint-url U --bucket B --key K --body F --content-type T --cache-control C
echo aws >> "$CALL_LOG"
[ "$1 $2" = "s3api put-object" ] || { echo "unexpected aws call: $*" >&2; exit 2; }
shift 2
key=""; file=""; ct=""; cc=""; ep=""
while [ $# -gt 0 ]; do case "$1" in
  --endpoint-url) ep="$2"; shift 2;; --bucket) shift 2;; --key) key="$2"; shift 2;;
  --body) file="$2"; shift 2;; --content-type) ct="$2"; shift 2;;
  --cache-control) cc="$2"; shift 2;; *) shift;; esac; done
[ "$AWS_ACCESS_KEY_ID" = "$EXPECT_KEY_ID" ] || { echo "wrong key id" >&2; exit 3; }
[ "$ep" = "https://acct.r2.cloudflarestorage.com" ] || { echo "wrong endpoint $ep" >&2; exit 3; }
[ -f "$file" ] || { echo "no such file: $file" >&2; exit 1; }
mkdir -p "$BUCKET_DIR/$(dirname "$key")"
cp "$file" "$BUCKET_DIR/$key"
echo "$key|$ct|$cc|s3" >> "$PUT_LOG"
`;

const CURL_STUB = `#!/usr/bin/env bash
url=""; out=""; head=0; wfmt=""
while [ $# -gt 0 ]; do case "$1" in
  -o) out="$2"; shift 2;; -I) head=1; shift;; -w) wfmt="$2"; shift 2;;
  --proto) shift 2;; http*) url="$1"; shift;; *) shift;; esac; done
echo "$url" >> "$CURL_LOG"
if [ -n "$STATUS_5XX" ] && [ "\${url%"$STATUS_5XX"}" != "$url" ]; then
  [ -n "$wfmt" ] && printf 503; exit 22
fi
path="$BUCKET_DIR/\${url#https://*/}"
if [ -n "$wfmt" ]; then if [ -f "$path" ]; then printf 200; else printf 404; fi; exit 0; fi
[ -f "$path" ] || exit 22
[ "$head" = 1 ] && exit 0
if [ -n "$out" ]; then cp "$path" "$out"; else cat "$path"; fi
`;

interface Fixture {
  dir: string;
  bucket: string;
  log: string;
  dist: string;
  env: Record<string, string>;
}

function fixture(): Fixture & Disposable {
  const scratch = scratchDir("publish-r2-");
  const dir = scratch.path;
  const bin = `${dir}/bin`;
  const bucket = `${dir}/bucket`;
  const dist = `${dir}/dist`;
  for (const d of [bin, bucket, dist]) Deno.mkdirSync(d);
  Deno.writeTextFileSync(`${bin}/wrangler`, WRANGLER_STUB, { mode: 0o755 });
  Deno.writeTextFileSync(`${bin}/curl`, CURL_STUB, { mode: 0o755 });
  Deno.writeTextFileSync(`${bin}/aws`, AWS_STUB, { mode: 0o755 });
  const log = `${dir}/puts.log`;
  Deno.writeTextFileSync(log, "");
  Deno.writeTextFileSync(`${dir}/curl.log`, "");
  Deno.writeTextFileSync(`${dir}/calls.log`, "");
  return {
    dir,
    bucket,
    log,
    dist,
    env: {
      PATH: `${bin}:${Deno.env.get("PATH")}`,
      BUCKET_DIR: bucket,
      PUT_LOG: log,
      CURL_LOG: `${dir}/curl.log`,
      CALL_LOG: `${dir}/calls.log`,
      CLI_BASE_URL: "https://cli.test",
      WRANGLER: `${bin}/wrangler`,
    },
    [Symbol.dispose]: () => scratch[Symbol.dispose](),
  };
}

async function sha256(path: string): Promise<string> {
  // Deno's own digest: the Dagger cliTest image has no shasum.
  const bytes = await crypto.subtle.digest("SHA-256", Deno.readFileSync(path));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A build in `dist/`: two binaries and a matching SHA256SUMS. */
async function build(f: Fixture, flavour = "a") {
  const files: Record<string, string> = {
    "confeature-aarch64-apple-darwin": `mac-${flavour}`,
    "confeature-x86_64-pc-windows-msvc.exe": `win-${flavour}`,
  };
  const sums: string[] = [];
  for (const [name, body] of Object.entries(files)) {
    Deno.writeTextFileSync(`${f.dist}/${name}`, body);
    sums.push(`${await sha256(`${f.dist}/${name}`)}  ${name}`);
  }
  Deno.writeTextFileSync(`${f.dist}/SHA256SUMS`, sums.join("\n") + "\n");
  // A release's own install scripts sit in dist too — they must never be published.
  Deno.writeTextFileSync(`${f.dist}/install.sh`, "OLD SCRIPT POINTING AT GITHUB");
}

function run(f: Fixture, ...args: string[]) {
  const { code, stdout, stderr } = new Deno.Command("bash", {
    args: [SCRIPT, ...args],
    cwd: ROOT,
    env: f.env,
  }).outputSync();
  const dec = new TextDecoder();
  return { code, out: dec.decode(stdout) + dec.decode(stderr) };
}

const puts = (f: Fixture) => Deno.readTextFileSync(f.log).trim().split("\n").filter(Boolean);
const keys = (f: Fixture) => puts(f).map((l) => l.split("|")[0]);

Deno.test("upload puts every binary, then SHA256SUMS last, all immutable", async () => {
  using f = fixture();
  await build(f);
  assertEquals(run(f, "upload", "0.2.0", f.dist).code, 0);
  const k = keys(f);
  assertEquals(k.at(-1), "v0.2.0/SHA256SUMS");
  assertEquals(k.sort(), [
    "v0.2.0/SHA256SUMS",
    "v0.2.0/confeature-aarch64-apple-darwin",
    "v0.2.0/confeature-x86_64-pc-windows-msvc.exe",
  ]);
  for (const line of puts(f)) assertStringIncludes(line, "immutable");
  assertEquals(k.includes("v0.2.0/install.sh"), false);
});

Deno.test("upload refuses a binary that does not match its own SHA256SUMS, before any put", async () => {
  using f = fixture();
  await build(f);
  Deno.writeTextFileSync(`${f.dist}/confeature-aarch64-apple-darwin`, "tampered");
  const r = run(f, "upload", "0.2.0", f.dist);
  assertEquals(r.code, 1);
  assertStringIncludes(r.out, "does not match SHA256SUMS");
  assertEquals(puts(f), []);
});

Deno.test("a byte-identical re-run resumes with no put; a different build is refused", async () => {
  using f = fixture();
  await build(f);
  assertEquals(run(f, "upload", "0.2.0", f.dist).code, 0);
  Deno.writeTextFileSync(f.log, "");
  const again = run(f, "upload", "0.2.0", f.dist);
  assertEquals(again.code, 0);
  assertStringIncludes(again.out, "identical");
  assertEquals(puts(f), []);

  await build(f, "b");
  const other = run(f, "upload", "0.2.0", f.dist);
  assertEquals(other.code, 3);
  assertStringIncludes(other.out, "DIFFERENT");
  assertEquals(puts(f), []);
});

Deno.test("promote refuses while an asset is not served, and writes no latest", async () => {
  using f = fixture();
  await build(f);
  run(f, "upload", "0.2.0", f.dist);
  Deno.removeSync(`${f.bucket}/v0.2.0/confeature-aarch64-apple-darwin`);
  Deno.writeTextFileSync(f.log, "");
  const r = run(f, "promote", "0.2.0");
  assertEquals(r.code, 1);
  assertStringIncludes(r.out, "is not served");
  assertEquals(keys(f).includes("latest"), false);
});

Deno.test("promote refuses a version never uploaded", () => {
  using f = fixture();
  const r = run(f, "promote", "9.9.9");
  assertEquals(r.code, 1);
  assertStringIncludes(r.out, "not published");
  assertEquals(puts(f), []);
});

Deno.test("promote puts the checkout's scripts, then latest LAST, exactly X.Y.Z, no-cache", async () => {
  using f = fixture();
  await build(f);
  run(f, "upload", "0.2.0", f.dist);
  Deno.writeTextFileSync(f.log, "");
  assertEquals(run(f, "promote", "0.2.0").code, 0);
  assertEquals(keys(f), ["install.sh", "install.ps1", "latest"]);
  for (const line of puts(f)) assertStringIncludes(line, "|no-cache");
  assertEquals(Deno.readTextFileSync(`${f.bucket}/latest`), "0.2.0");
  assertEquals(
    Deno.readTextFileSync(`${f.bucket}/install.sh`),
    Deno.readTextFileSync(`${ROOT}apps/cli/install.sh`),
  );
});

Deno.test("a failed put stops the run before latest moves", async () => {
  using f = fixture();
  await build(f);
  run(f, "upload", "0.2.0", f.dist);
  f.env.FAIL_PUT = "install.ps1";
  Deno.writeTextFileSync(f.log, "");
  assertEquals(run(f, "promote", "0.2.0").code !== 0, true);
  assertEquals(keys(f).includes("latest"), false);
});

Deno.test("invalid versions and arguments are refused with 2", () => {
  using f = fixture();
  for (const args of [["upload", "0.2", f.dist], ["promote", "../x"], ["promote"], ["nope"]]) {
    assertEquals(run(f, ...args).code, 2, JSON.stringify(args));
  }
  assertEquals(puts(f), []);
});

Deno.test("a failed put during upload resumes on re-run, keeping identical stored assets", async () => {
  using f = fixture();
  await build(f);
  f.env.FAIL_PUT = "v0.2.0/confeature-x86_64-pc-windows-msvc.exe";
  assertEquals(run(f, "upload", "0.2.0", f.dist).code !== 0, true);
  delete f.env.FAIL_PUT;
  Deno.writeTextFileSync(f.log, "");
  const again = run(f, "upload", "0.2.0", f.dist);
  assertEquals(again.code, 0, again.out);
  assertStringIncludes(again.out, "already stored, identical");
  // The stored mac binary is NOT re-put (the lock would refuse it).
  assertEquals(keys(f).includes("v0.2.0/confeature-aarch64-apple-darwin"), false);
  assertEquals(keys(f).at(-1), "v0.2.0/SHA256SUMS");
});

Deno.test("a stored asset with different bytes is refused — the number is taken", async () => {
  using f = fixture();
  await build(f);
  Deno.mkdirSync(`${f.bucket}/v0.2.0`, { recursive: true });
  Deno.writeTextFileSync(
    `${f.bucket}/v0.2.0/confeature-aarch64-apple-darwin`,
    "someone else's build",
  );
  const r = run(f, "upload", "0.2.0", f.dist);
  assertEquals(r.code, 3);
  assertStringIncludes(r.out, "DIFFERENT bytes");
});

Deno.test("a 5xx is never read as 'not published'", async () => {
  using f = fixture();
  await build(f);
  f.env.STATUS_5XX = "/v0.2.0/SHA256SUMS";
  const r = run(f, "upload", "0.2.0", f.dist);
  assertEquals(r.code, 1);
  assertStringIncludes(r.out, "HTTP 503");
  assertEquals(puts(f), []);
});

Deno.test("promote never moves latest backwards; rollback does, and only backwards", async () => {
  using f = fixture();
  await build(f);
  run(f, "upload", "0.2.0", f.dist);
  await build(f, "b");
  run(f, "upload", "0.10.0", f.dist);
  assertEquals(run(f, "promote", "0.10.0").code, 0);
  const back = run(f, "promote", "0.2.0");
  assertEquals(back.code, 4);
  assertStringIncludes(back.out, "BACKWARDS");
  assertEquals(Deno.readTextFileSync(`${f.bucket}/latest`), "0.10.0");
  assertEquals(run(f, "rollback", "0.10.0").code, 4); // not older
  assertEquals(run(f, "rollback", "0.2.0").code, 0);
  assertEquals(Deno.readTextFileSync(`${f.bucket}/latest`), "0.2.0");
  assertEquals(run(f, "promote", "0.2.0").code, 0); // re-promoting the same is idempotent
});

Deno.test("with no CLI_BASE_URL, the host comes from install.sh's BASE_URL", () => {
  using f = fixture();
  delete f.env.CLI_BASE_URL;
  run(f, "promote", "9.9.9");
  const urls = Deno.readTextFileSync(`${f.dir}/curl.log`);
  const base = Deno.readTextFileSync(`${ROOT}apps/cli/install.sh`).match(/^BASE_URL="(.*)"$/m)![1];
  assertStringIncludes(urls, `${base}/latest`);
});

Deno.test("a relative dist dir still uploads when wrangler runs from another directory", async () => {
  // cli-v0.3.0's first run: the workflow passes \`dist\` relative to the
  // checkout, and the real wrangler runs under \`pnpm --dir\`, elsewhere.
  using f = fixture();
  await build(f);
  const { code, stdout, stderr } = new Deno.Command("bash", {
    args: [SCRIPT, "upload", "1.2.3", "dist"],
    cwd: f.dir,
    env: { ...f.env, STUB_CWD: "/" },
  }).outputSync();
  const dec = new TextDecoder();
  if (code !== 0) throw new Error(dec.decode(stdout) + dec.decode(stderr));
  if (!puts(f).some((p) => p.startsWith("v1.2.3/SHA256SUMS|"))) {
    throw new Error("SHA256SUMS was not put");
  }
});

Deno.test("with R2 S3 credentials, every put goes through the S3 API, never wrangler", async () => {
  using f = fixture();
  await build(f);
  const env = {
    ...f.env,
    R2_ACCESS_KEY_ID: "kid",
    R2_SECRET_ACCESS_KEY: "secret",
    CLOUDFLARE_ACCOUNT_ID: "acct",
    EXPECT_KEY_ID: "kid",
    WRANGLER: "false",
  };
  const { code, stdout, stderr } = new Deno.Command("bash", {
    args: [SCRIPT, "upload", "1.2.3", "dist"],
    cwd: f.dir,
    env,
  }).outputSync();
  const dec = new TextDecoder();
  if (code !== 0) throw new Error(dec.decode(stdout) + dec.decode(stderr));
  const all = puts(f);
  if (all.length === 0 || !all.every((p) => p.endsWith("|s3"))) throw new Error(all.join("\n"));
});

// The stub aws would ACCEPT these puts (EXPECT_KEY_ID matches): without the
// guard in put(), the upload goes through the S3 API with a half-set
// credential, so this fails on the guard's absence, not on a stub mismatch
// (#794 review: the old version passed with the guard deleted).
for (
  const [what, half] of [
    ["the secret", { R2_ACCESS_KEY_ID: "kid", CLOUDFLARE_ACCOUNT_ID: "acct" }],
    ["the account id", { R2_ACCESS_KEY_ID: "kid", R2_SECRET_ACCESS_KEY: "secret" }],
  ] as const
) {
  Deno.test(`an S3 key id without ${what} is refused before aws or wrangler runs`, async () => {
    using f = fixture();
    await build(f);
    const { code, stdout, stderr } = new Deno.Command("bash", {
      args: [SCRIPT, "upload", "1.2.3", f.dist],
      cwd: ROOT,
      env: { ...f.env, ...half, EXPECT_KEY_ID: "kid" },
    }).outputSync();
    const dec = new TextDecoder();
    assertEquals(code, 1);
    assertStringIncludes(
      dec.decode(stdout) + dec.decode(stderr),
      "R2_ACCESS_KEY_ID is set without R2_SECRET_ACCESS_KEY and CLOUDFLARE_ACCOUNT_ID",
    );
    assertEquals(Deno.readTextFileSync(f.env.CALL_LOG), "");
    assertEquals(puts(f), []);
  });
}
