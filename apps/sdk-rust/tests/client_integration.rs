// SPDX-License-Identifier: MIT

//! Integration tests for the public `Client` + `ClientBuilder` surface.
//!
//! Coverage focus:
//! - Builder validation (empty SDK key → `BuildError::InvalidSdkKey`).
//! - Builder validation (zero timeout → `BuildError::InvalidOption`).
//! - `close()` consumes — type-level idempotence (can't be called twice).
//! - Custom `reqwest::Client` injection (smoke build).
//! - `get_value` after `close()` returns the supplied default.
//! - LocalOnly `force_refresh` is a no-op success.
//! - Snapshot is usable after `Drop` of the parent client.

mod common;

use confeature::{
    BuildError, Client, FlagOverrides, LogFacadeLogger, LogLevel, MapOverrideDataSource,
    OverrideBehaviour, PollingMode,
};
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

const TEST_SDK_KEY: &str =
    "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

#[tokio::test(flavor = "current_thread")]
async fn empty_sdk_key_returns_invalid_sdk_key() {
    let err = Client::builder("")
        .build()
        .expect_err("empty key must fail");
    assert!(matches!(err, BuildError::InvalidSdkKey), "got {err:?}");
}

#[tokio::test(flavor = "current_thread")]
async fn zero_http_timeout_returns_invalid_option() {
    let err = Client::builder(TEST_SDK_KEY)
        .polling_mode(PollingMode::ManualPoll)
        .http_timeout(Duration::ZERO)
        .build()
        .expect_err("zero timeout must fail");
    assert!(matches!(err, BuildError::InvalidOption(_)), "got {err:?}");
}

#[tokio::test(flavor = "current_thread")]
async fn invalid_format_key_logs_warning_but_builds() {
    // Lenient runtime — invalid format triggers a warning, never an error.
    let client = Client::builder("not-a-conformant-key")
        .polling_mode(PollingMode::ManualPoll)
        .logger(Arc::new(LogFacadeLogger::new(LogLevel::Off)))
        .build()
        .expect("lenient build");
    client.close();
}

#[tokio::test(flavor = "current_thread")]
async fn custom_http_client_accepted() {
    let custom = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .expect("build reqwest client");
    let client = Client::builder(TEST_SDK_KEY)
        .polling_mode(PollingMode::ManualPoll)
        .http_client(custom)
        .logger(Arc::new(LogFacadeLogger::new(LogLevel::Off)))
        .build()
        .expect("client build");
    client.close();
}

#[tokio::test(flavor = "current_thread")]
async fn get_value_with_empty_cache_returns_default() {
    // ManualPoll + no eager fetch → cache is empty → evaluator returns
    // the supplied default. Documents the spec FR-012 happy-path
    // "default-on-miss" contract.
    let client = Client::builder(TEST_SDK_KEY)
        .polling_mode(PollingMode::ManualPoll)
        .cache_directory(std::path::PathBuf::from(":memory:"))
        .logger(Arc::new(LogFacadeLogger::new(LogLevel::Off)))
        .build()
        .expect("client build");
    let got: bool = client.get_value("any.flag", true, None).await;
    assert!(got, "empty cache must return supplied default");
    client.close();
}

#[tokio::test(flavor = "current_thread")]
async fn local_only_force_refresh_is_no_op_success() {
    let overrides = FlagOverrides::new(
        Box::new(MapOverrideDataSource::new(HashMap::new())),
        OverrideBehaviour::LocalOnly,
    );
    let client = Client::builder(TEST_SDK_KEY)
        .polling_mode(PollingMode::ManualPoll)
        .flag_overrides(overrides)
        .logger(Arc::new(LogFacadeLogger::new(LogLevel::Off)))
        .build()
        .expect("client build");
    let r = client.force_refresh().await;
    assert!(r.is_ok(), "LocalOnly force_refresh must succeed: {r:?}");
    client.close();
}

#[tokio::test(flavor = "current_thread")]
async fn snapshot_survives_client_drop() {
    let mut map = HashMap::new();
    map.insert("k".to_string(), json!(true));
    let overrides = FlagOverrides::new(
        Box::new(MapOverrideDataSource::new(map)),
        OverrideBehaviour::LocalOnly,
    );
    let client = Client::builder(TEST_SDK_KEY)
        .polling_mode(PollingMode::ManualPoll)
        .flag_overrides(overrides)
        .logger(Arc::new(LogFacadeLogger::new(LogLevel::Off)))
        .build()
        .expect("client build");
    let snap = client.snapshot();
    client.close();

    // Snapshot stays usable after the client is closed.
    let got: bool = snap.get_value("k", false, None);
    assert!(got, "snapshot must resolve overrides post-close");
}

#[tokio::test(flavor = "current_thread")]
async fn lazy_load_with_memory_cache_builds() {
    // Exercise the option setters that aren't covered by the corpus run.
    let client = Client::builder(TEST_SDK_KEY)
        .polling_mode(PollingMode::lazy_load_default())
        .cache_directory(std::path::PathBuf::from(":memory:"))
        .base_url("https://example.invalid")
        .logger(Arc::new(LogFacadeLogger::new(LogLevel::Off)))
        .build()
        .expect("client build");
    client.close();
}

#[test]
fn workspace_root_helper_walks_up_to_pnpm_workspace() {
    // Smoke-test for the test infrastructure itself (T023).
    let root = common::workspace_root();
    assert!(
        root.join("pnpm-workspace.yaml").is_file(),
        "workspace_root() did not land on a directory containing pnpm-workspace.yaml: {}",
        root.display()
    );
    assert!(
        common::parity_corpus_path().is_file(),
        "parity-corpus.json not found at expected path"
    );
    assert!(
        common::cache_key_fixtures_path().is_file(),
        "cache-key-fixtures.json not found at expected path"
    );
}
