# Confeature SDKs and CLI

The client SDKs and the command-line tool for [Confeature](https://confeature.io), the hosted
feature-flag service. Every SDK is a drop-in replacement for the matching ConfigCat SDK: same
method names, same options, same polling and cache behaviour. Moving from ConfigCat means changing
the base URL, or the SDK key, and nothing else.

Everything here is MIT-licensed (see [LICENSE](LICENSE)). All 21 SDKs, the shared evaluation
engine and the wire-case corpus they are tested against live in this one repository, so a change to
the evaluation rules is tested across every language at once.

## SDKs

| SDK                | Package                                          | Install                                                                                                             |
| :----------------- | :----------------------------------------------- | :------------------------------------------------------------------------------------------------------------------ |
| Node.js            | `@confeature/sdk-node` (npm)                     | `npm install @confeature/sdk-node`                                                                                  |
| Browser JS         | `@confeature/sdk-browser-js` (npm)               | `npm install @confeature/sdk-browser-js`                                                                            |
| React              | `@confeature/sdk-react` (npm)                    | `npm install @confeature/sdk-react`                                                                                 |
| Angular            | `@confeature/sdk-angular` (npm)                  | `npm install @confeature/sdk-angular @confeature/sdk-browser-js`                                                    |
| Cloudflare Workers | `@confeature/sdk-cloudflare-worker` (npm)        | `npm install @confeature/sdk-cloudflare-worker @confeature/sdk-browser-js`                                          |
| Bun                | `@confeature/sdk-bun` (npm)                      | `bun add @confeature/sdk-bun`                                                                                       |
| Deno               | `@confeature/sdk-deno` (npm)                     | `import { ConfeatureClient } from "npm:@confeature/sdk-deno";`                                                      |
| Python             | `confeature-client` (PyPI)                       | `pip install confeature-client`                                                                                     |
| Go                 | `github.com/confeature/sdks/apps/sdk-go`         | `go get github.com/confeature/sdks/apps/sdk-go@latest`                                                              |
| Rust               | `confeature` (crates.io)                         | `cargo add confeature`                                                                                              |
| Ruby               | `confeature` (RubyGems)                          | `gem install confeature`                                                                                            |
| PHP                | `confeature/confeature-php-sdk` (Packagist)      | `composer require confeature/confeature-php-sdk`                                                                    |
| .NET               | `Confeature.Client` (NuGet)                      | `dotnet add package Confeature.Client`                                                                              |
| Java               | `io.confeature:confeature-java-sdk` (Maven)      | not published yet: see the note below                                                                               |
| Android            | `io.confeature:confeature-android-sdk` (Maven)   | not published yet: see the note below                                                                               |
| Kotlin             | `io.confeature:confeature-kotlin-mp-sdk` (Maven) | not published yet: see the note below                                                                               |
| Dart / Flutter     | `confeature` (pub.dev)                           | `dart pub add confeature`                                                                                           |
| Elixir             | `confeature_client` (Hex)                        | `{:confeature_client, "~> 0.1"}` in `mix.exs`                                                                       |
| Swift              | `Confeature`                                     | not available yet: see the note below                                                                               |
| C++                | `confeature::confeature` (CMake)                 | `FetchContent_Declare(confeature GIT_REPOSITORY https://github.com/confeature/sdks.git SOURCE_SUBDIR apps/sdk-cpp)` |
| Unreal Engine      | the `Confeature` plugin                          | copy `apps/sdk-unreal/Plugins/Confeature` into your project's `Plugins/`                                            |

**Not installable yet.** Two distributions are still being settled (#794): the Swift package — Swift
Package Manager needs a `Package.swift` at the repository root, and the Swift SDK lives under
`apps/sdk-swift/` — and the Maven releases of the Java, Android and Kotlin SDKs, whose builds do not
publish yet. Until then, build them from source in their directories. The Maven coordinates above are
the ones their builds produce.

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
