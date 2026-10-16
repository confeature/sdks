// SPDX-License-Identifier: MIT

// The Maven release check (tools/sdk-pack/check-maven-release.mjs): one case
// per refusal, so each rule is seen to fail closed, and the CLI on a real
// directory tree.

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { releaseProblems } from "../sdk-pack/check-maven-release.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(ROOT, "tools/sdk-pack/check-maven-release.mjs");

const GROUP = "io.confeature";
const ROOT_ID = "confeature-x-client";
const COORDINATES = `${GROUP}:${ROOT_ID}`;
const VERSION = "0.2.0";

const pom = (aid, version = VERSION, over = {}) => {
  const f = {
    name: "<name>Confeature X client</name>",
    description: "<description>Confeature SDK for X.</description>",
    url: "<url>https://github.com/confeature/sdks</url>",
    licenses: "<licenses><license><name>MIT</name></license></licenses>",
    developers:
      "<developers><developer><id>makerlabs</id><name>MakerLabs</name></developer></developers>",
    scm: "<scm><connection>scm:git:https://github.com/confeature/sdks.git</connection><url>https://github.com/confeature/sdks</url></scm>",
    ...over,
  };
  return `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <!-- do_not_remove: published-with-gradle-metadata -->
  <modelVersion>4.0.0</modelVersion>
  <groupId>${GROUP}</groupId>
  <artifactId>${aid}</artifactId>
  <version>${version}</version>
  ${Object.values(f).join("\n  ")}
  <dependencies>
    <dependency><groupId>org.example</groupId><artifactId>dep</artifactId><version>1.0.0</version></dependency>
  </dependencies>
</project>
`;
};

const metadata = (aid, versions) => `<?xml version="1.0" encoding="UTF-8"?>
<metadata>
  <groupId>${GROUP}</groupId>
  <artifactId>${aid}</artifactId>
  <versioning>
    <latest>${versions.at(-1)}</latest>
    <release>${versions.at(-1)}</release>
    <versions>
${versions.map((v) => `      <version>${v}</version>`).join("\n")}
    </versions>
    <lastUpdated>20261016000000</lastUpdated>
  </versioning>
</metadata>
`;

const digest = (alg, body) => createHash(alg).update(body).digest("hex");

/** Every file Gradle writes for `files`, with its four checksums. */
function withSums(files) {
  const out = {};
  for (const [path, body] of Object.entries(files)) {
    out[path] = body;
    for (const alg of ["md5", "sha1", "sha256", "sha512"])
      out[`${path}.${alg}`] = digest(alg, body);
  }
  return out;
}

/** A complete release of `aids` at VERSION, as `publishAllPublicationsToReleaseRepository` writes it. */
function release(aids = [ROOT_ID], versions = [VERSION]) {
  const files = {};
  for (const aid of aids) {
    const base = `io/confeature/${aid}`;
    const v = `${base}/${VERSION}/${aid}-${VERSION}`;
    files[`${v}.pom`] = pom(aid);
    files[`${v}.module`] = "{}";
    files[`${v}.jar`] = `jar of ${aid}`;
    files[`${v}-sources.jar`] = `sources of ${aid}`;
    files[`${v}-javadoc.jar`] = `javadoc of ${aid}`;
    files[`${base}/maven-metadata.xml`] = metadata(aid, versions);
  }
  return withSums(files);
}

/** Every artifact id of a tree, answered "absent" (a 404) by the live repository. */
const absent = (tree) =>
  Object.fromEntries(
    Object.keys(tree)
      .filter((p) => p.startsWith("io/confeature/"))
      .map((p) => [p.split("/")[2], null]),
  );
/** The tree's artifacts, each a first release unless `live` answers for it. */
const check = (tree, live = {}) =>
  releaseProblems(tree, COORDINATES, VERSION, { ...absent(tree), ...live });
const P = `io/confeature/${ROOT_ID}/${VERSION}/${ROOT_ID}-${VERSION}`;

describe("releaseProblems", () => {
  it("accepts a complete single-artifact release", () => {
    expect(check(release())).toEqual([]);
  });

  it("accepts a multiplatform release: the root and its suffixed targets", () => {
    expect(check(release([ROOT_ID, `${ROOT_ID}-jvm`, `${ROOT_ID}-iosarm64`]))).toEqual([]);
  });

  it("refuses an empty tree", () => {
    expect(check({})).toEqual([`no ${COORDINATES} in the release`]);
  });

  it("refuses a file outside the unit's group", () => {
    const t = { ...release(), ...withSums({ "com/example/x/1.0/x-1.0.pom": "x" }) };
    expect(check(t)).toContain(
      "com/example/x/1.0/x-1.0.pom: outside group io.confeature (io/confeature/)",
    );
  });

  it("refuses an artifact id that is not the unit's, nor a target of it", () => {
    const t = { ...release(), ...release(["confeature-y-client"]) };
    expect(check(t)).toContain(
      `io/confeature/confeature-y-client: artifact id confeature-y-client is not ${ROOT_ID} nor ${ROOT_ID}-<target>`,
    );
  });

  it("refuses an earlier version directory: the upload would rewrite a released version", () => {
    const t = {
      ...release(),
      ...withSums({
        [`io/confeature/${ROOT_ID}/0.1.0/${ROOT_ID}-0.1.0.pom`]: pom(ROOT_ID, "0.1.0"),
      }),
    };
    expect(check(t)).toContain(
      `io/confeature/${ROOT_ID}/0.1.0/${ROOT_ID}-0.1.0.pom: version 0.1.0 is not the release (${VERSION})`,
    );
  });

  it("refuses a stray file beside the metadata", () => {
    const t = { ...release(), [`io/confeature/${ROOT_ID}/notes.txt`]: "x" };
    expect(check(t)).toContain(
      `io/confeature/${ROOT_ID}/notes.txt: neither maven-metadata.xml nor a file of version ${VERSION}`,
    );
  });

  it("refuses a version file not named <artifactId>-<version>", () => {
    const t = {
      ...release(),
      ...withSums({ [`io/confeature/${ROOT_ID}/${VERSION}/other.jar`]: "x" }),
    };
    expect(check(t)).toContain(
      `io/confeature/${ROOT_ID}/${VERSION}/other.jar: not named ${ROOT_ID}-${VERSION}*`,
    );
  });

  it("refuses a file with no md5 or sha1 beside it", () => {
    for (const alg of ["md5", "sha1"]) {
      const t = release();
      delete t[`${P}.jar.${alg}`];
      expect(check(t)).toEqual([`${P}.jar: no .${alg} checksum`]);
    }
  });

  it("refuses a checksum that does not match its file, for every algorithm", () => {
    for (const alg of ["md5", "sha1", "sha256", "sha512"]) {
      const t = release();
      t[`${P}.jar.${alg}`] = "0".repeat(t[`${P}.jar.${alg}`].length);
      expect(check(t)).toEqual([`${P}.jar.${alg}: does not match ${P}.jar`]);
    }
  });

  it("refuses a checksum whose file is missing", () => {
    const t = release();
    delete t[`${P}.module`];
    expect(check(t)).toContain(`${P}.module.md5: a checksum of a file the release does not carry`);
  });

  it("refuses an artifact with no POM", () => {
    const t = release();
    for (const ext of ["", ".md5", ".sha1", ".sha256", ".sha512"]) delete t[`${P}.pom${ext}`];
    expect(check(t)).toEqual([`io/confeature/${ROOT_ID}/${VERSION}: no ${ROOT_ID}-${VERSION}.pom`]);
  });

  it("refuses a main artifact without its sources or javadoc jar", () => {
    for (const cls of ["sources", "javadoc"]) {
      const t = release();
      for (const ext of ["", ".md5", ".sha1", ".sha256", ".sha512"])
        delete t[`${P}-${cls}.jar${ext}`];
      expect(check(t)).toEqual([
        `io/confeature/${ROOT_ID}/${VERSION}: no ${ROOT_ID}-${VERSION}-${cls}.jar`,
      ]);
    }
  });

  it("requires sources and javadoc beside an aar or a klib too", () => {
    const t = release();
    for (const ext of ["", ".md5", ".sha1", ".sha256", ".sha512"]) {
      delete t[`${P}.jar${ext}`];
      delete t[`${P}-javadoc.jar${ext}`];
    }
    Object.assign(t, withSums({ [`${P}.klib`]: "klib" }));
    expect(check(t)).toEqual([
      `io/confeature/${ROOT_ID}/${VERSION}: no ${ROOT_ID}-${VERSION}-javadoc.jar`,
    ]);
  });

  /** The POM at P, rewritten, with its checksums recomputed. */
  const withPom = (body) => ({ ...release(), ...withSums({ [`${P}.pom`]: body }) });

  it("refuses a POM of another group, artifact or version", () => {
    expect(check(withPom(pom(ROOT_ID, "0.2.1")))).toEqual([
      `${P}.pom: <version> is 0.2.1, not ${VERSION}`,
    ]);
    expect(
      check(
        withPom(
          pom(ROOT_ID).replace(`<artifactId>${ROOT_ID}</artifactId>`, "<artifactId>x</artifactId>"),
        ),
      ),
    ).toEqual([`${P}.pom: <artifactId> is x, not ${ROOT_ID}`]);
    expect(
      check(
        withPom(pom(ROOT_ID).replace(`<groupId>${GROUP}</groupId>`, "<groupId>com.x</groupId>")),
      ),
    ).toEqual([`${P}.pom: <groupId> is com.x, not ${GROUP}`]);
  });

  it("reads the project's own coordinates, never a dependency's", () => {
    const body = pom(ROOT_ID).replace(
      "<groupId>io.confeature</groupId>\n  <artifactId>",
      "<artifactId>",
    );
    expect(check(withPom(body))).toEqual([`${P}.pom: <groupId> is absent, not ${GROUP}`]);
  });

  it("refuses a POM missing any required metadata", () => {
    const cases = {
      name: "no <name>",
      description: "no <description>",
      url: "no <url>",
      licenses: "no MIT licence",
      developers: "no developer named MakerLabs",
      scm: "no <scm> with a <connection> and a <url>",
    };
    for (const [field, why] of Object.entries(cases))
      expect(check(withPom(pom(ROOT_ID, VERSION, { [field]: "" })))).toEqual([`${P}.pom: ${why}`]);
  });

  it("refuses a licence other than MIT and a developer other than MakerLabs", () => {
    expect(
      check(
        withPom(
          pom(ROOT_ID, VERSION, {
            licenses: "<licenses><license><name>Apache-2.0</name></license></licenses>",
          }),
        ),
      ),
    ).toEqual([`${P}.pom: no MIT licence`]);
    expect(
      check(
        withPom(
          pom(ROOT_ID, VERSION, {
            developers: "<developers><developer><name>Someone</name></developer></developers>",
          }),
        ),
      ),
    ).toEqual([`${P}.pom: no developer named MakerLabs`]);
  });

  it("refuses an address anywhere in a POM, and an <email> element", () => {
    const at = pom(ROOT_ID, VERSION, {
      scm: "<scm><connection>scm:git:ssh://git@github.com/confeature/sdks.git</connection><url>https://github.com/confeature/sdks</url></scm>",
    });
    expect(check(withPom(at))).toEqual([`${P}.pom: carries an '@' (no address may be published)`]);
    const email = pom(ROOT_ID, VERSION, {
      developers:
        "<developers><developer><name>MakerLabs</name><email>x</email></developer></developers>",
    });
    expect(check(withPom(email))).toEqual([`${P}.pom: carries an <email> element`]);
  });

  it("refuses an artifact with no maven-metadata.xml", () => {
    const t = release();
    for (const ext of ["", ".md5", ".sha1", ".sha256", ".sha512"])
      delete t[`io/confeature/${ROOT_ID}/maven-metadata.xml${ext}`];
    expect(check(t)).toEqual([`io/confeature/${ROOT_ID}: no maven-metadata.xml`]);
  });

  it("refuses metadata that does not list the release", () => {
    const t = {
      ...release(),
      ...withSums({
        [`io/confeature/${ROOT_ID}/maven-metadata.xml`]: metadata(ROOT_ID, ["0.1.0"]),
      }),
    };
    expect(check(t)).toEqual([
      `io/confeature/${ROOT_ID}/maven-metadata.xml: does not list ${VERSION}`,
    ]);
  });

  it("refuses metadata of another artifact", () => {
    const t = {
      ...release(),
      ...withSums({ [`io/confeature/${ROOT_ID}/maven-metadata.xml`]: metadata("x", [VERSION]) }),
    };
    expect(check(t)).toEqual([
      `io/confeature/${ROOT_ID}/maven-metadata.xml: names io.confeature:x, not ${COORDINATES}`,
    ]);
  });

  it("accepts metadata that keeps every live version", () => {
    const t = release([ROOT_ID], ["0.1.0", "0.1.1", VERSION]);
    expect(check(t, { [ROOT_ID]: metadata(ROOT_ID, ["0.1.0", "0.1.1"]) })).toEqual([]);
  });

  it("refuses metadata that drops a live version: it would vanish from the listing", () => {
    const t = release([ROOT_ID], ["0.1.1", VERSION]);
    expect(check(t, { [ROOT_ID]: metadata(ROOT_ID, ["0.1.0", "0.1.1"]) })).toEqual([
      `io/confeature/${ROOT_ID}/maven-metadata.xml: drops 0.1.0, which the live metadata lists`,
    ]);
  });

  it("refuses a release whose version is already live", () => {
    const t = release([ROOT_ID], ["0.1.0", VERSION]);
    expect(check(t, { [ROOT_ID]: metadata(ROOT_ID, ["0.1.0", VERSION]) })).toEqual([
      `io/confeature/${ROOT_ID}: ${VERSION} is already published (live maven-metadata.xml lists it)`,
    ]);
  });

  it("refuses an artifact the live repository gave no answer for: never guessed a first release", () => {
    // A fetch that failed, or a step that skipped one, leaves no file: that is
    // not a 404, and reading it as one publishes metadata that drops every
    // earlier version (#794 review).
    const t = release([ROOT_ID, `${ROOT_ID}-jvm`]);
    expect(releaseProblems(t, COORDINATES, VERSION, { [ROOT_ID]: null })).toEqual([
      `${ROOT_ID}-jvm: no answer from the live repository (neither ${ROOT_ID}-jvm.xml nor ${ROOT_ID}-jvm.absent): refusing to guess whether it has releases`,
    ]);
    expect(releaseProblems(t, COORDINATES, VERSION)).toHaveLength(2);
  });

  it.each([
    ["an empty body", ""],
    ["an error page", "<html><body>502 Bad Gateway</body></html>"],
    ["another artifact's metadata", metadata("other", ["0.1.0"])],
    [
      "metadata listing no version",
      metadata(ROOT_ID, []).replace(/<version>[^<]*<\/version>/g, ""),
    ],
  ])("refuses a live answer that is %s: a 200 is not proof of metadata", (_, body) => {
    const problems = check(release([ROOT_ID], ["0.1.0", VERSION]), { [ROOT_ID]: body });
    expect(problems).toContain(
      `${ROOT_ID}: the live maven-metadata.xml is not metadata of ${COORDINATES} listing a version: refusing to guess`,
    );
  });

  it("refuses live metadata for an artifact the release does not carry", () => {
    expect(check(release(), { [`${ROOT_ID}-jvm`]: metadata(`${ROOT_ID}-jvm`, ["0.1.0"]) })).toEqual(
      [`${ROOT_ID}-jvm: live metadata for an artifact this release does not publish`],
    );
  });
});

describe("the CLI", () => {
  const tree = (files) => {
    const dir = mkdtempSync(join(tmpdir(), "maven-release-"));
    for (const [f, body] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), body);
    }
    return dir;
  };
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

  it("exits 0 on a complete release, its live answer a 404 marker or the live metadata", () => {
    const first = run(tree(release()), COORDINATES, VERSION, tree({ [`${ROOT_ID}.absent`]: "" }));
    expect(first.status, first.stderr).toBe(0);
    const repo = tree(release([ROOT_ID], ["0.1.0", VERSION]));
    const live = tree({ [`${ROOT_ID}.xml`]: metadata(ROOT_ID, ["0.1.0"]) });
    const r = run(repo, COORDINATES, VERSION, live);
    expect(r.status, r.stderr).toBe(0);
  });

  it("exits 1 when the live directory holds no answer for an artifact (a failed fetch)", () => {
    const r = run(tree(release()), COORDINATES, VERSION, tree({ "unrelated.txt": "" }));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("no answer from the live repository");
  });

  it("exits 2 without a live directory: the live state is never assumed", () => {
    expect(run(tree(release()), COORDINATES, VERSION).status).toBe(2);
  });

  it("exits 1 and names each problem", () => {
    const files = release();
    delete files[`${P}.jar.sha1`];
    const r = run(tree(files), COORDINATES, VERSION, tree({ [`${ROOT_ID}.absent`]: "" }));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`::error::${P}.jar: no .sha1 checksum`);
  });

  it("exits 1 on an empty tree", () => {
    expect(run(tree({}), COORDINATES, VERSION, tree({})).status).toBe(1);
  });

  it("exits 2 on a missing argument, bad coordinates or an unreadable directory", () => {
    const live = tree({});
    expect(run(tree(release()), COORDINATES).status).toBe(2);
    expect(run(tree(release()), "no-colon", VERSION, live).status).toBe(2);
    expect(run(join(tmpdir(), "no-such-dir-maven"), COORDINATES, VERSION, live).status).toBe(2);
    expect(run(tree(release()), COORDINATES, VERSION, join(tmpdir(), "no-such-live")).status).toBe(
      2,
    );
  });
});
