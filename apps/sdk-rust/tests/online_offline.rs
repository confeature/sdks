// SPDX-License-Identifier: MIT

//! Spec 095 / #267 — slice 6/14 — sdk-rust online/offline triplet.
//!
//! Mirrors the upstream `configcat::Client.offline()` / `online()` / `is_offline()` verb-form
//! methods, including LocalOnly edge cases. Conformance lives in
//! `tests/api_surface_conformance.rs`; this file exercises behaviour.
//!
//! Closed-client tests are intentionally OMITTED: `Client::close(self)` consumes the receiver
//! (type-level idempotence), so calling `is_offline()` on a closed client is not expressible
//! through the public API.

mod common;

use confeature::{
    Client, FlagOverrides, LogFacadeLogger, LogLevel, MapOverrideDataSource, OverrideBehaviour,
    PollingMode, RefreshError,
};
use std::collections::HashMap;
use std::sync::Arc;

const TEST_SDK_KEY: &str =
    "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

fn build_manual_client() -> Client {
    Client::builder(TEST_SDK_KEY)
        .polling_mode(PollingMode::ManualPoll)
        .logger(Arc::new(LogFacadeLogger::new(LogLevel::Off)))
        .build()
        .expect("client build")
}

fn build_local_only_client() -> Client {
    let mut map = HashMap::new();
    map.insert("feature.x".to_string(), serde_json::json!(true));
    let overrides = FlagOverrides::new(
        Box::new(MapOverrideDataSource::new(map)),
        OverrideBehaviour::LocalOnly,
    );
    Client::builder(TEST_SDK_KEY)
        .polling_mode(PollingMode::ManualPoll)
        .flag_overrides(overrides)
        .logger(Arc::new(LogFacadeLogger::new(LogLevel::Off)))
        .build()
        .expect("client build")
}

// ── default state ────────────────────────────────────────────────────

#[tokio::test(flavor = "current_thread")]
async fn freshly_constructed_client_is_online() {
    let client = build_manual_client();
    assert!(!client.is_offline(), "default state must be online");
    client.close();
}

// ── basic state transitions ──────────────────────────────────────────

#[tokio::test(flavor = "current_thread")]
async fn offline_flips_the_flag() {
    let client = build_manual_client();
    client.offline();
    assert!(client.is_offline());
    client.close();
}

#[tokio::test(flavor = "current_thread")]
async fn online_resets_the_flag() {
    let client = build_manual_client();
    client.offline();
    assert!(client.is_offline());
    client.online();
    assert!(!client.is_offline());
    client.close();
}

#[tokio::test(flavor = "current_thread")]
async fn setters_are_idempotent() {
    let client = build_manual_client();
    client.offline();
    client.offline();
    client.offline();
    assert!(client.is_offline());
    client.online();
    client.online();
    client.online();
    assert!(!client.is_offline());
    client.close();
}

// ── force_refresh interaction ────────────────────────────────────────

#[tokio::test(flavor = "current_thread")]
async fn force_refresh_while_offline_returns_offline_error() {
    let client = build_manual_client();
    client.offline();
    let r = client.force_refresh().await;
    assert!(matches!(r, Err(RefreshError::Offline)), "got {r:?}");
    client.close();
}

// ── LocalOnly semantics ──────────────────────────────────────────────

#[tokio::test(flavor = "current_thread")]
async fn local_only_client_is_offline_by_definition() {
    let client = build_local_only_client();
    assert!(client.is_offline(), "LocalOnly must report offline=true");
    client.close();
}

#[tokio::test(flavor = "current_thread")]
async fn local_only_online_is_no_op() {
    let client = build_local_only_client();
    client.online();
    assert!(
        client.is_offline(),
        "LocalOnly stays offline even after online()"
    );
    client.close();
}

#[tokio::test(flavor = "current_thread")]
async fn local_only_offline_is_silent_no_op() {
    let client = build_local_only_client();
    client.offline();
    // No assertion on a log channel — the contract is "no panic, idempotent".
    assert!(client.is_offline());
    client.close();
}

#[tokio::test(flavor = "current_thread")]
async fn local_only_force_refresh_returns_ok_not_offline() {
    // LocalOnly is checked BEFORE the offline gate — upstream parity.
    let client = build_local_only_client();
    let r = client.force_refresh().await;
    assert!(r.is_ok(), "LocalOnly force_refresh must succeed: {r:?}");
    client.close();
}
