// SPDX-License-Identifier: MIT

export const RELEASE_PACK_GATES = {
  "check:npm-tarball": {
    // The npm tarball is the unit the resolver accepted, carries no workspace
    // range and a LICENSE, and contains every entry point its manifest names
    // (#899: sdk-angular packed a manifest with none). It runs in the pack job,
    // before the dry run and long before the upload that cannot be undone.
    script: "tools/sdk-pack/check-npm-tarball.mjs",
    homes: [
      {
        file: ".github/workflows/sdk-publish.yml",
        before: "npm publish --dry-run (no credentials)",
      },
    ],
  },
  "check:maven-release": {
    // The JVM SDKs go to a static Maven repository on R2 (#902), which stores
    // whatever it is given, so the checks a registry would make run here: the
    // release is exactly the unit's, at the resolved version, with matching
    // checksums, sources and javadoc jars, and complete POMs that carry no
    // address; and its metadata keeps every live version. It runs in the Maven
    // pack job, before the probe of the live repository and the upload.
    script: "tools/sdk-pack/check-maven-release.mjs",
    homes: [
      {
        file: ".github/workflows/sdk-publish.yml",
        before: "Probe maven.confeature.io for the new version (no credentials)",
      },
    ],
  },
  "check:hex-tarball": {
    // The Hex package is the unit the resolver accepted (#909): named
    // <name>-<version>.tar, tarball format 3 with exactly its four entries,
    // and metadata declaring that name, app and version once each. It runs in
    // the Hex pack job, after `mix hex.build` and before the digest the
    // publish job uploads by.
    script: "tools/sdk-pack/check-hex-tarball.sh",
    homes: [
      {
        file: ".github/workflows/sdk-publish.yml",
        before: "Record the Hex package digest",
      },
    ],
  },
  "split-mirror": {
    // The PHP and Swift SDKs are published as mirror repositories whose
    // history is this split of the unit's directory, and a pushed history
    // cannot be taken back: the split is refused when any commit in it carries
    // an author, committer or message address that is not a noreply one
    // (#901). Each mirror's pack job runs it, before its dry run.
    script: "tools/sdk-pack/split-mirror.sh",
    homes: [
      {
        file: ".github/workflows/sdk-publish.yml",
        before: "composer validate --strict (no credentials)",
        perJob: true,
      },
      {
        file: ".github/workflows/sdk-publish.yml",
        before: "swift build against the mirror (no credentials)",
        perJob: true,
      },
    ],
  },
};
