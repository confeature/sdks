<!-- SPDX-License-Identifier: MIT -->

# Confeature Rust SDK

`confeature` is the Rust client for the [Confeature](https://confeature.io)
feature-flag service. It is a drop-in replacement for the upstream
[`configcat`](https://crates.io/crates/configcat) crate — migration is
one line in `Cargo.toml` plus a rename of the `use` paths.

> **Status**: pre-release (`0.1.0`). Boolean evaluation only in this
> wave; string / int / double evaluators land before crates.io publish
> (epic #29).

## Install

```bash
cargo add confeature
```

…or pin the version manually in `Cargo.toml`:

```toml
[dependencies]
confeature = "0.1"
```

Requires Rust 1.86+ (edition 2021). `tokio` is the default async runtime.
To use `async-std` instead:

```toml
[dependencies]
confeature = { version = "0.1", default-features = false, features = ["async-std-runtime"] }
```

## Quickstart

```rust
use confeature::Client;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = Client::builder("configcat-sdk-1/<22-char>/<22-char>").build()?;
    let dark_mode: bool = client.get_value("feature.dark-mode", false, None).await;
    println!("dark-mode = {dark_mode}");
    client.close();
    Ok(())
}
```

SDK keys come in two shapes, both accepted:

- `configcat-sdk-1/<22 chars>/<22 chars>` — minted today; ConfigCat's own
  key shape, so the same key also works with a stock `configcat` client.
- `confeature-sdk-1-<32 chars>-<32 chars>` — minted before; still valid
  until you rotate the key.

`confeature::is_valid_confeature_key_format` checks a key against both. A
key of neither shape only logs a redacted `INVALID_SDK_KEY` warning — the
client still builds.

The default polling mode (`AutoPoll`) spawns a Tokio task that fetches
the latest config every 60 seconds in the background. Each
`get_value` call is served from an atomic in-memory snapshot —
sub-microsecond — and returns the supplied default on any failure path.
The SDK never panics from a public method.

## Migrate from ConfigCat

```diff
- configcat = "0.3"
+ confeature = "0.1"
```

```diff
- use configcat::{Client, PollingMode};
+ use confeature::{Client, PollingMode};
```

```diff
- let client = configcat::Client::builder("CONFIGCAT-KEY").build()?;
+ let client = confeature::Client::builder("CONFEATURE-KEY").build()?;
```

Method signatures, builder options, polling-mode names, and override
semantics all match the upstream `configcat` crate 1:1. The 58-tuple
parity corpus at `packages/test-fixtures-sdk-parity/` gates byte-
identical output against the Node, Go, .NET, and Python SDKs.

## Polling modes

- `PollingMode::AutoPoll { poll_interval, max_init_wait_time }` — default
  60 s / 5 s. Background Tokio task fetches on a tick.
- `PollingMode::LazyLoad { cache_refresh_interval }` — default 60 s.
  Fetches on-demand when the cached entry is stale.
- `PollingMode::ManualPoll` — no automatic fetches; the customer drives
  `force_refresh()` explicitly.

```rust
use confeature::{Client, PollingMode};

let client = Client::builder("configcat-sdk-1/...")
    .polling_mode(PollingMode::ManualPoll)
    .build()?;
client.force_refresh().await?;
```

## Local overrides

```rust
use confeature::{Client, FlagOverrides, MapOverrideDataSource, OverrideBehaviour};
use std::collections::HashMap;

let mut map = HashMap::new();
map.insert("feature.dark-mode".to_string(), serde_json::json!(true));

let overrides = FlagOverrides::new(
    Box::new(MapOverrideDataSource::new(map)),
    OverrideBehaviour::LocalOnly,
);

let client = Client::builder("configcat-sdk-1/...")
    .flag_overrides(overrides)
    .build()?;
```

Only `LocalOnly` is wired in this wave. `LocalOverRemote` and
`RemoteOverLocal` are accepted at the type level (for ABI parity) but
return the supplied default at evaluation time.

The Rust SDK inherits the spec-036 snapshot-correctness fix from day
one: `client.snapshot().get_value()` resolves overrides synchronously
before any background poll has happened.

## Feature flags

| Cargo feature       | Default | Pulls in                          |
| ------------------- | ------- | --------------------------------- |
| `tokio-runtime`     | yes     | `tokio` (rt, time, fs, sync, ...) |
| `async-std-runtime` | no      | `async-std`                       |

The two runtime features are mutually exclusive. Opting into
`async-std-runtime` requires `default-features = false`.

## Local development

```bash
# Format + lint + test + build, the full local gate:
pnpm run rust:ready

# Or individually from apps/sdk-rust/:
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test --release
cargo build --release
```

## Documentation & support

- Docs: [confeature.io/docs/sdks/rust](https://confeature.io/docs/sdks/rust)
- Issue tracker: <https://github.com/confeature/sdks/issues>
- Source: [`apps/sdk-rust/`](./) in the `confeature/sdks` repository.

## License

[MIT](./LICENSE) — see `LICENSE`.
