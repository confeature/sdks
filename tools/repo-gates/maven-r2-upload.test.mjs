// SPDX-License-Identifier: MIT

// tools/sdk-pack/maven-r2-upload.sh, the publish-maven job's one reviewed
// upload (#794 review, round 3), against a stub `aws` that stores objects in a
// directory and a stub `curl`: the order of the puts, immutability, and the
// credential refusal.

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(ROOT, "tools/sdk-pack/maven-r2-upload.sh");

// aws s3api --endpoint-url E (put-object --bucket B --key K --body F [...] [--if-none-match '*'] | get-object --bucket B --key K OUT)
const AWS = `#!/usr/bin/env bash
echo "aws $*" >> "$CALLS"
shift 3
verb="$1"; shift
key=""; body=""; inm=0; out=""
while [ $# -gt 0 ]; do case "$1" in
  --key) key="$2"; shift 2;; --body) body="$2"; shift 2;;
  --if-none-match) [ "$2" = "*" ] || { echo "if-none-match is $2, not *" >&2; exit 9; }; inm=1; shift 2;;
  --bucket|--content-type|--cache-control) shift 2;; *) out="$1"; shift;; esac; done
if [ "$verb" = put-object ]; then
  if [ "$inm" = 1 ] && [ -f "$STORE/$key" ]; then echo "An error occurred (PreconditionFailed)" >&2; exit 254; fi
  mkdir -p "$STORE/$(dirname "$key")"; cp "$body" "$STORE/$key"
  if [ "$inm" = 1 ]; then echo "put $key" >> "$PUTS"; else echo "put $key (unconditional)" >> "$PUTS"; fi; exit 0
fi
[ -f "$STORE/$key" ] || { echo "An error occurred (NoSuchKey)" >&2; exit 254; }
cp "$STORE/$key" "$out"
`;
const CURL = `#!/usr/bin/env bash
echo "curl $*" >> "$CALLS"
`;

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "maven-r2-"));
  dirs.push(dir);
  for (const d of ["bin", "store", "release"]) mkdirSync(join(dir, d));
  for (const [name, body] of [
    ["aws", AWS],
    ["curl", CURL],
  ]) {
    writeFileSync(join(dir, "bin", name), body);
    chmodSync(join(dir, "bin", name), 0o755);
  }
  const base = "release/io/confeature/x";
  const files = {
    [`${base}/0.2.0/x-0.2.0.jar`]: "jar",
    [`${base}/0.2.0/x-0.2.0.pom`]: "pom",
    [`${base}/maven-metadata.xml`]:
      "<metadata><version>0.1.0</version><version>0.2.0</version></metadata>",
    [`${base}/maven-metadata.xml.sha1`]: "sum",
  };
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), body);
  }
  for (const f of ["calls", "puts"]) writeFileSync(join(dir, f), "");
  return dir;
}

/** The variables the script reads, each of which the publish-maven job must define. */
const SCRIPT_ENV = {
  MAVEN_R2_ACCESS_KEY_ID: "kid",
  MAVEN_R2_SECRET_ACCESS_KEY: "secret",
  CLOUDFLARE_ACCOUNT_ID: "acct",
  UNIT_COORDINATES: "io.confeature:x",
  UNIT_VERSION: "0.2.0",
  MAVEN_BUCKET: "confeature-maven",
  MAVEN_URL: "https://maven.test",
};

function run(dir, over = {}) {
  return spawnSync("bash", [SCRIPT, "release"], {
    cwd: dir,
    encoding: "utf8",
    env: {
      PATH: `${join(dir, "bin")}:${process.env.PATH}`,
      CALLS: join(dir, "calls"),
      PUTS: join(dir, "puts"),
      STORE: join(dir, "store"),
      ...SCRIPT_ENV,
      ...over,
    },
  });
}
const read = (dir, f) => readFileSync(join(dir, f), "utf8");

describe("maven-r2-upload.sh", () => {
  it("puts the version's files first and the metadata last, then reads the POM back", () => {
    const dir = fixture();
    const r = run(dir);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(read(dir, "puts").trim().split("\n")).toEqual([
      "put io/confeature/x/0.2.0/x-0.2.0.jar",
      "put io/confeature/x/0.2.0/x-0.2.0.pom",
      "put io/confeature/x/maven-metadata.xml.sha1 (unconditional)",
      "put io/confeature/x/maven-metadata.xml (unconditional)",
    ]);
    expect(read(dir, "calls")).toContain("--endpoint-url https://acct.r2.cloudflarestorage.com");
    expect(read(dir, "calls")).toContain("curl --proto =https --tlsv1.2 -fsSI");
    expect(read(dir, "calls")).toContain("https://maven.test/io/confeature/x/0.2.0/x-0.2.0.pom");
  });

  it("keeps an identical stored file, and refuses one stored with other bytes", () => {
    const dir = fixture();
    mkdirSync(join(dir, "store/io/confeature/x/0.2.0"), { recursive: true });
    writeFileSync(join(dir, "store/io/confeature/x/0.2.0/x-0.2.0.jar"), "jar");
    const kept = run(dir);
    expect(kept.status, kept.stdout + kept.stderr).toBe(0);
    expect(kept.stdout).toContain("kept io/confeature/x/0.2.0/x-0.2.0.jar");
    writeFileSync(join(dir, "store/io/confeature/x/0.2.0/x-0.2.0.pom"), "another pom");
    const taken = run(dir);
    expect(taken.status).toBe(1);
    expect(taken.stdout).toContain("is already stored with other bytes");
  });

  it("refuses metadata that would drop a stored version", () => {
    const dir = fixture();
    mkdirSync(join(dir, "store/io/confeature/x"), { recursive: true });
    writeFileSync(
      join(dir, "store/io/confeature/x/maven-metadata.xml"),
      "<metadata><version>0.0.9</version></metadata>",
    );
    const r = run(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("would drop <version>0.0.9</version>");
    expect(read(dir, "puts")).toBe("");
  });

  it.each(["MAVEN_R2_ACCESS_KEY_ID", "MAVEN_R2_SECRET_ACCESS_KEY", "CLOUDFLARE_ACCOUNT_ID"])(
    "refuses to start without %s, before aws runs",
    (name) => {
      const dir = fixture();
      const r = run(dir, { [name]: "" });
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("must be set in environment sdk-publish-maven");
      expect(read(dir, "calls")).toBe("");
    },
  );

  it("is handed every variable it reads by the publish-maven job", () => {
    const doc = parseYaml(readFileSync(join(ROOT, ".github/workflows/sdk-publish.yml"), "utf8"));
    const job = doc.jobs["publish-maven"];
    const upload = job.steps.find(
      (s) => s.run === "bash tools/sdk-pack/maven-r2-upload.sh release",
    );
    expect(upload).toBeDefined();
    const defined = new Set([
      ...Object.keys(doc.env ?? {}),
      ...Object.keys(job.env ?? {}),
      ...Object.keys(upload.env ?? {}),
    ]);
    expect(Object.keys(SCRIPT_ENV).filter((k) => !defined.has(k))).toEqual([]);
    const script = readFileSync(SCRIPT, "utf8");
    const read = [...script.matchAll(/\$\{?([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]);
    const own = new Set(["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]);
    expect([...new Set(read)].filter((k) => !own.has(k) && !Object.hasOwn(SCRIPT_ENV, k))).toEqual(
      [],
    );
  });

  it("refuses a file outside the unit's artifacts, before aws runs", () => {
    const dir = fixture();
    mkdirSync(join(dir, "release/io/confeature/other/0.2.0"), { recursive: true });
    writeFileSync(join(dir, "release/io/confeature/other/0.2.0/other-0.2.0.jar"), "jar");
    const r = run(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(
      "io/confeature/other/0.2.0/other-0.2.0.jar is not under io/confeature/x/",
    );
    expect(read(dir, "calls")).toBe("");
  });

  it("a second version against the same store: jars, target descriptors, root descriptors, then metadata", () => {
    const dir = fixture();
    const write = (f, body) => {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), body);
    };
    const release = (version, versions) => {
      rmSync(join(dir, "release"), { recursive: true, force: true });
      for (const aid of ["x", "x-jvm"]) {
        const v = `release/io/confeature/${aid}/${version}/${aid}-${version}`;
        write(`${v}.jar`, `jar ${aid} ${version}`);
        write(`${v}.pom`, `pom ${aid} ${version}`);
        write(`${v}.module`, `module ${aid} ${version}`);
        write(
          `release/io/confeature/${aid}/maven-metadata.xml`,
          `<metadata>${versions.map((x) => `<version>${x}</version>`).join("")}</metadata>`,
        );
      }
    };
    release("0.1.0", ["0.1.0"]);
    expect(run(dir, { UNIT_VERSION: "0.1.0" }).status).toBe(0);
    writeFileSync(join(dir, "puts"), "");
    release("0.2.0", ["0.1.0", "0.2.0"]);
    const r = run(dir);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(read(dir, "puts").trim().split("\n")).toEqual([
      "put io/confeature/x-jvm/0.2.0/x-jvm-0.2.0.jar",
      "put io/confeature/x/0.2.0/x-0.2.0.jar",
      "put io/confeature/x-jvm/0.2.0/x-jvm-0.2.0.module",
      "put io/confeature/x-jvm/0.2.0/x-jvm-0.2.0.pom",
      "put io/confeature/x/0.2.0/x-0.2.0.module",
      "put io/confeature/x/0.2.0/x-0.2.0.pom",
      "put io/confeature/x-jvm/maven-metadata.xml (unconditional)",
      "put io/confeature/x/maven-metadata.xml (unconditional)",
    ]);
    expect(read(dir, "store/io/confeature/x/maven-metadata.xml")).toContain(
      "<version>0.1.0</version>",
    );
    expect(read(dir, "store/io/confeature/x/0.1.0/x-0.1.0.jar")).toBe("jar x 0.1.0");
  });
});
