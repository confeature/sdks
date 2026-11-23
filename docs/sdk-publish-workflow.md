<!-- SPDX-License-Identifier: MIT -->

# SDK publication workflow

Tag-triggered SDK publish: one tag publishes one unit to its registry.

Tag format: `sdk-<name>-v<X.Y.Z>`, for example `sdk-node-v0.1.0`. The units,
their registries, coordinates, version sources and publish order live in ONE
place: `publish[]` in dagger/sdk-manifest.json. This workflow never maps a
tag to a package itself.

The chain, each job gating the next (`needs:`):

0. workflow-rules tools/repo-gates/verify-workflows.mjs over this commit's
   workflows: a tag whose workflows break the rules is refused
   before anything else runs.
1. setup tools/sdk-pack/resolve-publish.mjs accepts the tag, or refuses
   it before any job that can reach a credential: unknown unit,
   registry `none`, blocked, pending gate, version mismatch, an
   `after` dependency not yet on its registry, or a commit that is
   not on main. Every value later jobs use comes from the unit,
   never from a substring of the tag, and reaches `run:` through
   `env:` only.
2. gate the unit's containerized suite (its `.sdks[]` daggerFn), unless
   the unit is `exempt`.
3. pack-\* ONE per registry. No environment, no `id-token`, no secret, no
   cache restore. It installs, runs the author rule, builds and
   packs the artifact, checks the artifact's own name and version
   against the resolver's, runs the registry's credential-free dry
   run, and hands the artifact on with its sha256 (go hands on
   nothing: its registry builds the module from the tag).
4. publish-\* ONE per registry, a top-level job bound to environment
   `sdk-publish-<registry>` (a tag-only
   deployment policy). It runs NO project code: it downloads the
   artifact from this same run, checks the digest, and runs the
   pinned upload command. OIDC trusted publishing wherever the
   registry has it; the trust configuration names this file AND
   the environment, so a job outside the environment gets nothing.
   The git routes have no OIDC: they push with an SSH
   deploy key held by their environment, and run only git.
5. conclude fails unless the registry's pack job (and, for a tag, its
   publish job) actually succeeded: a registry with no jobs here
   yet is a red run, never a green one that published nothing.

A `workflow_dispatch` run is a DRY RUN, always: it packs and runs the dry run
of the named unit, and no publish job can run (they require a tag push).
A dry run proves the packaging, not the OIDC binding; the first real tag
proves that.

The jobs, environments and rules here are checked by
tools/repo-gates/verify-workflows.mjs; the environments, their rules and
tag policies are declared in tools/repo-gates/release-settings.json.

Registries wired: npm (#899); pypi, crates, rubygems, nuget, pubdev (#900);
go, packagist, swiftpm (#901); maven (#902), which is not Maven Central but
a static Maven repository on Cloudflare R2, served at MAVEN_URL; jsr (#935),
which rides along a unit's primary registry; hex (#909).

JSR (#935): a unit with a `registry: "jsr"` entry in publish[] (today only
deno) also publishes to JSR from the SAME tag, at the SAME version: the
resolver emits the package as `jsr`, and pack-jsr / publish-jsr run beside
the primary registry's jobs, not instead of them. JSR publishes TypeScript
source: pack-jsr stages it out of the checkout with sdk-shared bundled and
dry-runs `deno publish` on the stage; publish-jsr publishes that same,
sha-checked stage, authenticated by this job's OIDC token. JSR trusts a linked REPOSITORY, not a workflow or an
environment: the operator links confeature/sdks once, in the package's
Settings on jsr.io (@confeature/sdk-deno > Settings > GitHub repository).
Three publish jobs package from source because their registry accepts
nothing else: publish-crates (`cargo publish --no-verify`, nothing compiled),
publish-pubdev (`dart pub publish --force`, which pub.dev requires in the
OIDC job) and publish-jsr (`deno publish` of the pack job's staged source,
which it unpacks first: `tar -x`). Rule 3 allows exactly those commands, in exactly
those jobs.

## Git mirrors

Packagist and SwiftPM read a whole repository, with its manifest at the
root, so the PHP and Swift SDKs are published as mirror repositories
(mirrors[] in release-settings.json). The pack job splits the unit's
history with tools/sdk-pack/split-mirror.sh, which refuses any commit that
carries a personal address, bundles it and dry-runs the mirror. The publish
job checks the bundle and pushes `main` and the release tag with the
mirror's deploy key, never forced: the same history splits to the same
commit, so `main` only fast-forwards, and a tag is never moved. Packagist
picks the tag up through the mirror's GitHub hook.

A SwiftPM mirror tag is the release. Its consumer dry run requires Apple's toolchain and runs on macOS.
The OpenFeature companion has its own mirror and deploy key. Its credential-free check builds a
consumer on the pinned Xcode and checks that SwiftPM resolves the base SDK from its public mirror.
Publish the base SDK 0.2.0 before running this check for the first companion release.

## Maven releases

The JVM SDKs are served by a static Maven repository on Cloudflare R2
(MAVEN_URL), not Maven Central (#902). R2 stores whatever it is given, so
the pack job enforces what a registry would: the release is exactly the
unit's, at the resolved version, with checksums that match, sources and
javadoc jars, and complete POMs carrying no address
(tools/sdk-pack/check-maven-release.mjs); and no file of that version is
live yet. A released version is never rewritten. The maven-metadata.xml
files are the only objects ever overwritten: the pack job puts the live ones
in Gradle's output repository and publishes again, and Gradle adds the new
version to the list, so every earlier one stays listed.

Every Maven pack runs on macOS: the Kotlin Multiplatform SDK publishes ALL
its targets from one host, in one run (its root module names every
target's), and only macOS builds the iOS targets. The Java and Android SDKs
build the same on any host, and a public repository's macOS minutes are
free. Nothing is signed (no key to hold): integrity is the Maven checksums
plus a GitHub artifact attestation of every file, made by the publish job.
