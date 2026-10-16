# Confeature SDKs and CLI

The client SDKs and the command-line tool for [Confeature](https://confeature.io), the hosted
feature-flag service. Every SDK is a drop-in replacement for the matching ConfigCat SDK: same
method names, same options, same polling and cache behaviour. Moving from ConfigCat means changing
the base URL, or the SDK key, and nothing else.

Everything here is MIT-licensed (see [LICENSE](LICENSE)). All 21 SDKs, the shared evaluation
engine and the wire-case corpus they are tested against live in this one repository, so a change to
the evaluation rules is tested across every language at once.

## SDKs

| SDK                | Package                                                         | Install                                                                                                             |
| :----------------- | :-------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------ |
| Node.js            | `@confeature/sdk-node` (npm)                                    | `npm install @confeature/sdk-node`                                                                                  |
| Browser JS         | `@confeature/sdk-browser-js` (npm)                              | `npm install @confeature/sdk-browser-js`                                                                            |
| React              | `@confeature/sdk-react` (npm)                                   | `npm install @confeature/sdk-react`                                                                                 |
| Angular            | `@confeature/sdk-angular` (npm)                                 | `npm install @confeature/sdk-angular @confeature/sdk-browser-js`                                                    |
| Cloudflare Workers | `@confeature/sdk-cloudflare-worker` (npm)                       | `npm install @confeature/sdk-cloudflare-worker @confeature/sdk-browser-js`                                          |
| Bun                | `@confeature/sdk-bun` (npm)                                     | `bun add @confeature/sdk-bun`                                                                                       |
| Deno               | `@confeature/sdk-deno` (npm)                                    | `import { ConfeatureClient } from "npm:@confeature/sdk-deno";`                                                      |
| Python             | `confeature-client` (PyPI)                                      | `pip install confeature-client`                                                                                     |
| Go                 | `github.com/confeature/sdks/apps/sdk-go`                        | `go get github.com/confeature/sdks/apps/sdk-go@latest`                                                              |
| Rust               | `confeature` (crates.io)                                        | `cargo add confeature`                                                                                              |
| Ruby               | `confeature` (RubyGems)                                         | `gem install confeature`                                                                                            |
| PHP                | `confeature/confeature-php-sdk` (Packagist)                     | `composer require confeature/confeature-php-sdk`                                                                    |
| .NET               | `Confeature.Client` (NuGet)                                     | `dotnet add package Confeature.Client`                                                                              |
| Java               | `io.confeature:confeature-java-client` (maven.confeature.io)    | `implementation("io.confeature:confeature-java-client:0.1.0")`, with the repository below                           |
| Android            | `io.confeature:confeature-android-client` (maven.confeature.io) | `implementation("io.confeature:confeature-android-client:0.1.0")`, with the repository below                        |
| Kotlin             | `io.confeature:confeature-kotlin-client` (maven.confeature.io)  | `implementation("io.confeature:confeature-kotlin-client:0.1.0")`, with the repository below                         |
| Dart / Flutter     | `confeature` (pub.dev)                                          | `dart pub add confeature`                                                                                           |
| Elixir             | `confeature_client` (Hex)                                       | `{:confeature_client, "~> 0.1"}` in `mix.exs`                                                                       |
| Swift              | `Confeature` (SwiftPM)                                          | `.package(url: "https://github.com/confeature/confeature-swift", from: "0.1.0")` in `Package.swift`                 |
| C++                | `confeature::confeature` (CMake)                                | `FetchContent_Declare(confeature GIT_REPOSITORY https://github.com/confeature/sdks.git SOURCE_SUBDIR apps/sdk-cpp)` |
| Unreal Engine      | the `Confeature` plugin                                         | copy `apps/sdk-unreal/Plugins/Confeature` into your project's `Plugins/`                                            |

**The JVM repository.** Confeature's JVM SDKs are served from maven.confeature.io, not Maven
Central. Add the repository once, next to the ones your build already uses:

```kotlin
// build.gradle.kts, or dependencyResolutionManagement in settings.gradle.kts
repositories {
    mavenCentral()
    maven { url = uri("https://maven.confeature.io") }
}
```

```xml
<!-- pom.xml -->
<repositories>
  <repository>
    <id>confeature</id>
    <url>https://maven.confeature.io</url>
  </repository>
</repositories>
```

Every published file carries Maven checksums and a GitHub artifact attestation:
`gh attestation verify <file> --repo confeature/sdks` checks one.

The PHP and Swift SDKs are published from read-only mirrors of their directories here,
[`confeature/confeature-php-sdk`](https://github.com/confeature/confeature-php-sdk) and
[`confeature/confeature-swift`](https://github.com/confeature/confeature-swift): Packagist and Swift
Package Manager read a repository whose manifest sits at its root. Changes are made here, in
`apps/sdk-php/` and `apps/sdk-swift/`.

Each SDK's own README, under `apps/sdk-<name>/`, covers its options, its examples and the details of
moving from ConfigCat.

## CLI

The `confeature` CLI manages flags from a terminal. It installs from `cli.confeature.io`:

```sh
# macOS and Linux
curl --proto '=https' --tlsv1.2 -fsSL https://cli.confeature.io/install.sh | sh
```

```powershell
# Windows
irm https://cli.confeature.io/install.ps1 | iex
```

Its source is in [`apps/cli`](apps/cli).

## Repository layout

- `apps/sdk-<name>/`: one SDK per directory, each built and tested with its own language's toolchain.
- `apps/cli/`: the CLI, a Deno project.
- `packages/sdk-shared/`: the evaluation engine the JavaScript SDKs share.
- `packages/test-fixtures-sdk-parity/`: the wire-case and parity corpus every SDK replays.
- `packages/contract/`: a read-only copy of the published API contract.
- `tools/test-harness-live-contract/`: a local reference server the SDKs' live suites run against.
- `dagger/`: the containerised test pipeline for every SDK.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). To report a vulnerability, see [SECURITY.md](SECURITY.md),
and do not open a public issue.

## Licence

MIT, copyright MakerLabs. See [LICENSE](LICENSE).
