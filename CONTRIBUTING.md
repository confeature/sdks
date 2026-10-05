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

| Where it runs                              | Gates                                                                                                                                                                                                                                             |
| :----------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm run verify`, the fast gate           | `verify:fmt-lint`, `verify:json-keys`, `verify:gate-declarations`, `verify:codeowners`, `verify:manifest-author`, `verify:sdk-extraction`, `verify:seed-schema`, `verify:wire-cases`, and the tests of `tools/repo-gates` and `tools/dagger-call` |
| `pnpm run ready`, the whole local gate     | `verify`, then `dagger:all` (every covered SDK in its container, after `dagger-precheck`), then `swift:check` (`swift-precheck`, native, macOS only)                                                                                              |
| Each SDK's `postbuild`                     | `check-bundle-size`, the gzip budget of each browser-facing bundle                                                                                                                                                                                |
| `sdk-publish.yml`, before "Publish to npm" | `verify:manifest-author`, because a registry keeps what it is given                                                                                                                                                                               |
