<!-- SPDX-License-Identifier: MIT -->

# Confeature Rust SDK

`confeature` is the Rust client for the [Confeature](https://confeature.io)
feature-flag service. It is a drop-in replacement for the upstream
[`configcat`](https://crates.io/crates/configcat) crate — migration is
one line in `Cargo.toml` plus a rename of the `use` paths.

## Install

```bash
cargo add confeature
```

…or pin the version manually in `Cargo.toml`:

```toml
[dependencies]
confeature = "0.2"
```

Requires Rust 1.86+ (edition 2021). `tokio` is the default async runtime.
The SDK's polling and HTTP code requires a Tokio runtime. An application
using async-std can run SDK work on its own Tokio runtime and await the result.

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
+ confeature = "0.2"
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
| `openfeature`       | no      | Official `open-feature` Rust SDK  |

The two runtime features are mutually exclusive. The `openfeature` feature
enables `tokio-runtime`.

## OpenFeature

Enable the `openfeature` Cargo feature with Rust 1.88 or later and
`open-feature` 0.3.0. Tokio runs the SDK's polling, HTTP requests and
evaluation. An async-std application can await work dispatched to its own
Tokio runtime.

```toml
[dependencies]
confeature = { version = "0.2", features = ["openfeature"] }
open-feature = "=0.3.0"
tokio = { version = "1", features = ["macros", "rt-multi-thread"] }
```

```rust
use std::sync::Arc;

use confeature::{openfeature::ConfeatureProvider, Client, PollingMode};
use open_feature::{provider::NoOpProvider, EvaluationContext, OpenFeature};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let sdk = Arc::new(
        Client::builder(std::env::var("CONFEATURE_SDK_KEY")?)
            .polling_mode(PollingMode::ManualPoll)
            .build()?,
    );
    sdk.force_refresh().await?;
    let provider = ConfeatureProvider::new(Arc::clone(&sdk)).map_err(|error| error.code)?;
    OpenFeature::singleton_mut()
        .await
        .set_named_provider("checkout", provider)
        .await;

    let client = OpenFeature::singleton().await.create_named_client("checkout");
    let context = EvaluationContext::default().with_targeting_key("customer-123");
    let dark_mode = client
        .get_bool_value("feature.dark-mode", Some(&context), None)
        .await
        .unwrap_or(false);
    println!("dark-mode = {dark_mode}");

    OpenFeature::singleton_mut()
        .await
        .set_named_provider("checkout", NoOpProvider::default())
        .await;
    drop(sdk);
    Ok(())
}
```

Build the client without `default_user`. The provider uses the OpenFeature
targeting key as Confeature's identifier and accepts string `Email` and
`Country` fields. Custom targeting fields support strings, integers, finite
decimals, booleans as strings, timestamps with fractional seconds, and
`Vec<String>` wrapped in `EvaluationContextFieldValue::new_struct`.

Registration is immediate. The SDK's polling mode still controls when data
arrives. For example, call `force_refresh` on a cold `ManualPoll` client
before expecting a flag value. OpenFeature 0.3.0 returns a `Result`. Use
`unwrap_or` to supply your application's default or handle the error directly.
An evaluation before configuration is available returns `PROVIDER_NOT_READY`.
A missing flag returns `FLAG_NOT_FOUND`.

The provider supports booleans, strings, `i64` and `f64`. A value with an
incompatible type or a request for a structured flag returns `TYPE_MISMATCH`.

The provider holds a shared `Arc<Client>`. Replacing the provider on its named
domain with `NoOpProvider` releases that reference after in-flight evaluations
finish. Your application owns its retained client reference and can keep
using it after OpenFeature cleanup.

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
