# Contributing

Thank you for helping. This repository holds the Confeature SDKs and CLI. Every SDK must stay a
drop-in replacement for the matching ConfigCat SDK, so a change to one SDK's public surface needs
the same care as a change to ConfigCat's.

## Before you start

- For anything larger than a small fix, open an issue first and describe the change.
- Security problems never go in a public issue: see [SECURITY.md](SECURITY.md).
- By contributing, you agree that your contribution is licensed under the MIT licence of this
  repository.

## Setting up

You need Node.js 22.12 or later and pnpm 11. The containerised SDK suites also need Docker and the
Dagger CLI (the version is pinned in `dagger/dagger.json`).

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm run verify
```

`pnpm run verify` is the fast gate and needs no container. `pnpm run ready` runs it, then every
SDK's containerised suite and, on macOS, the Swift SDK.

To test one SDK in its container:

```sh
pnpm dagger:go        # or dagger:python, dagger:rust, dagger:java, ...
```

## Pull requests

- Keep each pull request to one change, with a test that fails without it.
- Run `pnpm run verify` before you push, and the SDK's own suite (`pnpm dagger:<sdk>`) when you
  touch an SDK.
- Commit with your GitHub noreply address, so your personal email address never enters the
  history.
- No manifest carries an email address, in any author or contact field.
- Every PUBLISHED manifest names its author, and the author is exactly `MakerLabs`. An author may
  be absent only where the table below says so; anywhere an author is written, it is `MakerLabs`.
  The `verify:manifest-author` gate enforces both rules (`tools/manifest-author.mjs`).
- A change to the wire-case corpus is a change for every SDK at once: run every SDK's suite.

### Where an author is required

| Manifest                      | Author required                             | Field                               |
| :---------------------------- | :------------------------------------------ | :---------------------------------- |
| npm `package.json`            | unless `"private": true`                    | `author`                            |
| `composer.json`               | always                                      | `authors`                           |
| Unreal `.uplugin`             | always                                      | `CreatedBy`                         |
| `pyproject.toml`              | when it has a `[project]` table             | `authors`                           |
| `Cargo.toml`                  | for a `[package]` without `publish = false` | `authors`                           |
| `.gemspec`                    | always                                      | `authors`                           |
| `.csproj`, `.fsproj`          | unless `<IsPackable>false</IsPackable>`     | `<Authors>`                         |
| `.nuspec`                     | always                                      | `<authors>`                         |
| `mix.exs`                     | when it has a `package:` entry              | `maintainers`                       |
| `build.gradle(.kts)`          | when it publishes (maven-publish, `pom`)    | `developers { developer { name } }` |
| `deno.json`, `jsr.json`       | never: no author field                      | —                                   |
| `pubspec.yaml`                | never: pub.dev ignores author fields        | —                                   |
| `.props`, `gradle.properties` | never: shared build settings                | —                                   |
| `CMakeLists.txt`, `LICENSE`   | never: not published to a registry          | —                                   |
| `go.mod`, `Package.swift`     | never: no author field                      | —                                   |

## Quality gates

Each gate is declared in `tools/repo-gates/verify-declarations.mjs`, and `verify:gate-declarations`
checks that every declared gate is wired where this table says, and named in it.

| Where it runs                                                                                                              | Gates                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| :------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm run verify`, the fast gate, which `verify.yml` runs on every push to main and every pull request                     | `verify:fmt-lint`, `verify:json-keys`, `verify:gate-declarations`, `verify:workflows`, `verify:codeowners`, `verify:manifest-author`, `verify:sdk-extraction`, `verify:seed-schema`, `verify:wire-cases`, and the tests of `tools/repo-gates` and `tools/dagger-call`                                                                                                                                                                                                                                                                                                   |
| `sdk-gates.yml`, on every push to main, every pull request and once a day; its `sdk gates` job is a required check on main | each selected SDK's own Dagger suite, one `gate (<sdk>)` leg each, followed in that leg by its live wire-cases against the reference origin (`live-suite --sdk <sdk>`) when the manifest gives it a `liveSuite.runner`: `tools/repo-gates/select-sdks.mjs` selects them (every SDK on a push or the schedule; on a pull request, the SDKs it touches and their dependents, or every SDK when it touches anything outside one SDK's directory), and `tools/repo-gates/conclude-sdk-gates.mjs` decides `sdk gates`. `verify:workflows` rule 19 holds the workflow's shape |
| `pnpm run ready`, the whole local gate                                                                                     | `verify`, then `dagger:all` (every covered SDK in its container, after `dagger-precheck`), then `swift:check` (`swift-precheck`, native, macOS only)                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Each SDK's `postbuild`                                                                                                     | `check-bundle-size`, the gzip budget of each browser-facing bundle                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `sdk-publish.yml`, every pack job, before "Pack the release artifact"                                                      | `verify:manifest-author`, because a registry keeps what it is given: every registry's artifact is checked before it exists                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `sdk-publish.yml` and `cli-release.yml`, their first job, before anything that can reach a credential                      | `verify:workflows`, over the tagged commit's workflows: a tag whose workflows break the rules publishes nothing                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `cli-release.yml`, the build, release and upload jobs, first after their checkout                                          | `check-on-main` (apps/cli/scripts/check-on-main.sh): a `cli-v*` tag on a commit that is not on main builds and publishes nothing, re-checked in each job that holds a publishing token (attest, which checks nothing out and runs no project code, waits on build's)                                                                                                                                                                                                                                                                                                    |
| `sdk-publish.yml`, the npm pack job, before its dry run                                                                    | `check:npm-tarball`: the tarball is the resolved unit, has no `workspace:` range and a LICENSE, and contains every entry point it names                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `sdk-publish.yml`, the Packagist and SwiftPM pack jobs, before their dry runs                                              | `split-mirror`: the mirror's history is the unit's split, refused when any commit carries an author, committer or message address that is not a noreply one                                                                                                                                                                                                                                                                                                                                                                                                             |
| `sdk-publish.yml`, the Maven pack job, before its probe of the live repository                                             | `check:maven-release`: the release is exactly the unit's, at the resolved version, with matching checksums, sources and javadoc jars, POMs carrying no address, and metadata that keeps every live version                                                                                                                                                                                                                                                                                                                                                              |
| `sdk-publish.yml`, the Hex pack job, after `mix hex.build` and before its digest                                           | `check:hex-tarball`: the package is the resolved unit, named `<name>-<version>.tar`, tarball format 3 with exactly its four entries, and metadata declaring that name, app and version once each                                                                                                                                                                                                                                                                                                                                                                        |

## Proving a gate fails closed

A gate is trusted only once it has been seen to go red. Each SDK toolchain that `sdk-gates.yml` starts to judge is proved once,
by the change that adds it:

1. Branch `proof/<child>` from main, where `<child>` is the issue that adds the toolchain (for example `proof/910`).
2. Make one deliberate break per toolchain the change covers, and nothing else: for example, invert one assertion in the
   SDK's conformance or wire-case test.
3. Open a pull request from the branch. Check that the broken SDK's leg, `gate (<sdk>)`, is red, and that `sdk gates` is red
   and names the SDK in its summary.
4. Record the URL of each red run on the tracking epic.
5. Close the pull request without merging it, and delete the branch.

The break never reaches main. A green run from a branch that changes the gate's own files proves nothing: that run used
the branch's copy of the gate, so the break has to be in an SDK, never in the gate.

## Approving a fork's run

A pull request from a fork waits for a maintainer to approve its workflow run. Approving it runs the pull request's code on
this repository's runners, with a read-only token, so approval is the one check before a stranger's code executes. Before
you approve, read every change the pull request makes under:

- `.github/`, which holds the workflows and CODEOWNERS;
- `dagger/`, which holds every SDK's suite and the manifest that routes it;
- `tools/` and `scripts/`, which hold the gates and the selector;
- each build file's lifecycle hooks, which run code at install or build time: `package.json` scripts (`preinstall`,
  `install`, `postinstall`, `prepare`, and any `pre`/`post` script of a task the suites run), Gradle build scripts and
  plugins, Cargo `build.rs`, Python build backends, `mix.exs`, `CMakeLists.txt`, `Package.swift`, MSBuild targets in
  `.csproj` and `.props` files, Composer scripts, and Rakefiles and gemspecs.

The first line of the `sdk gates` summary lists the gate files the pull request changes. When it lists any, the run judged
the pull request with its own copy of those files, so its green is self-attested: review those files as the gate itself.

Whether a new push to an approved fork pull request waits for approval again: to be observed and recorded here.

## Changing a frozen release job

`verify:workflows` freezes the release workflows (`tools/repo-gates/verify-workflows.mjs`, rule 17): every action of `sdk-publish.yml`, `cli-release.yml` and `release-gate.yml` is recorded in `ACTION_SURFACE`, and the jobs in `FROZEN_JOB_KEYS` (cli-release's build, release, attest and upload, release-gate's test) are recorded whole, run steps by the sha256 of their `run:` text, with their job keys and their workflow's `env:` and `defaults:`. To change one:

1. Change the step (or job) in the workflow.
2. Run `pnpm run verify:workflows`. It prints, for each step that changed, `step <n> (<name>) is <got>, ACTION_SURFACE records <want>`; `<got>` carries the new `run.sha256` (or, for github-script, `with.script.sha256`).
3. Copy `<got>` into the matching entry of `ACTION_SURFACE` (or `FROZEN_JOB_KEYS`, `FROZEN_WORKFLOW_KEYS`), then rerun until it prints `verify-workflows: ok`.
4. Commit the workflow and the recorded surface together, and review them together: the hash records that this exact text was reviewed, nothing more.
