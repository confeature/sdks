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
  "swiftpm-consumer": {
    // Resolve the staged companion from a clean scratch project before the
    // public dependency check. The base's older macOS smoke stays separate.
    script: "tools/sdk-pack/check-swiftpm-consumer.sh",
    homes: [
      {
        file: ".github/workflows/sdk-publish.yml",
        before: "Check the companion's public dependencies",
        perJob: true,
        direct: true,
      },
    ],
  },
  "swiftpm-public-dependencies": {
    script: "tools/sdk-pack/check-swiftpm-resolved.mjs",
    homes: [
      {
        file: ".github/workflows/sdk-publish.yml",
        before: "Build the companion's consumer (no credentials)",
        perJob: true,
        direct: true,
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
      {
        file: ".github/workflows/sdk-publish.yml",
        before: "Resolve the companion's consumer",
        perJob: true,
      },
    ],
  },
};

export const SWIFT_NATIVE_SUITE_RUN = "bash scripts/swift-precheck.sh";
export const SWIFT_OPENFEATURE_LIVE_RUN = "node tools/sdk-swift-openfeature/run.mjs";

const swiftpmPackRuns = [
  SWIFT_NATIVE_SUITE_RUN,
  "pnpm --filter @confeature/test-harness-live-contract build",
  SWIFT_OPENFEATURE_LIVE_RUN,
  "bash tools/sdk-pack/check-swiftpm-consumer.sh openfeature",
  'node tools/sdk-pack/check-swiftpm-resolved.mjs "$RUNNER_TEMP/consume/consumer/Package.resolved"',
  'xcrun swift build --package-path "$RUNNER_TEMP/consume/consumer" --force-resolved-versions',
];

// Distinct steps make Xcode and the compiled test package from GITHUB_ENV
// available to the seeded suite. Neither a skip nor a test failure may upload.
export function swiftpmCompanionPackProblem(job) {
  const steps = Array.isArray(job?.steps) ? job.steps : [];
  const matches = [
    ...swiftpmPackRuns.map((command) => (step) => step?.run === command),
    (step) =>
      step?.with?.name === "release-swiftpm-openfeature" &&
      step.uses?.startsWith("actions/upload-artifact@"),
  ];
  let previous = -1;
  for (const match of matches) {
    const found = steps.findIndex(match);
    if (found <= previous || steps.findLastIndex(match) !== found)
      return "the SwiftPM companion must run the native suite, harness build, seeded loopback, dependency checks, consumer build and upload once each in that order";
    const step = steps[found];
    if (
      step.if !== undefined ||
      step["continue-on-error"] !== undefined ||
      step.shell !== undefined
    )
      return `the SwiftPM companion step "${step.name}" must run unconditionally and fail on errors`;
    previous = found;
  }
  return null;
}
