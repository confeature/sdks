// SPDX-License-Identifier: MIT

//! Spec 071 US3 — API-surface conformance test for `sdk-rust`.
//!
//! Pins the official ConfigCat Rust SDK (`configcat` crate, v0.1.5)
//! as a test-scope dependency in `Cargo.toml` and asserts that the
//! Confeature [`confeature::Client`] surface is a conforming superset
//! of the ConfigCat [`configcat::Client`] core evaluation surface —
//! a consumer migrating from `configcat` changes only the SDK key
//! plus the `use` line, and every core type / method they reference
//! still resolves.
//!
//! Rust has no runtime reflection, so the present-method conformance
//! is encoded as **compile-time call sites** inside `async fn` probes
//! that are NEVER invoked. The probes are only compiled — if a method
//! named on the conformance list is removed or renamed on either
//! `configcat::Client` or `confeature::Client`, this file fails to
//! compile.
//!
//! KNOWN DIVERGENCE (#264) — spec 071 is SPLIT-scoped (research §R0):
//! it delivers typed-value parity + this conformance test only. The
//! ConfigCat methods listed under [`KNOWN_DIVERGENCES_264`] are NOT
//! mirrored on [`confeature::Client`] today. They are documented here
//! as a drift-guard: when the #264 follow-on adds one, the probe
//! against `confeature::Client` is added (and the entry is removed
//! from the list).
//!
//! No network, no client instantiation — every probe is dead code
//! that the compiler still type-checks.

#![allow(dead_code, unused_variables)]

use confeature::{Client as ConfeatureClient, User};
use configcat::Client as ConfigCatClient;
use std::collections::HashMap;
use std::time::Duration;

// ── 1. Sanity guard — the official SDK is on the test classpath ──────

#[test]
fn configcat_sdk_is_on_the_test_classpath() {
    // The compile-time probes below already prove this; the runtime
    // sentinel is here to surface a clear failure in test output if
    // the dev-dep ever drops out.
    let _builder_exists: fn(&str) -> configcat::ClientBuilder = ConfigCatClient::builder;
}

// ── 2. Core conformance — methods present on BOTH SDKs ───────────────
//
// `async fn` probes that exercise each method by name + arity. They
// are never invoked (the test below just asserts the compile-time
// existence by referencing them). Lifetime gymnastics are sidestepped
// by writing real async functions instead of `fn` pointers.

async fn probe_confeature_get_value(c: &ConfeatureClient) -> bool {
    c.get_value::<bool>("key", false, None).await
}

async fn probe_configcat_get_value(c: &ConfigCatClient) -> bool {
    c.get_value::<bool>("key", false, None).await
}

async fn probe_confeature_force_refresh(c: &ConfeatureClient) {
    let _ = c.force_refresh().await;
}

// ── Spec 084 — get_value_details + get_all_values landed (#266 slice 6) ──

async fn pin_confeature_get_value_details(
    c: &ConfeatureClient,
) -> confeature::EvaluationDetails<bool> {
    c.get_value_details::<bool>("k", false, None).await
}

async fn pin_confeature_get_all_values(c: &ConfeatureClient) -> HashMap<String, confeature::Value> {
    c.get_all_values(None).await
}

fn pin_confeature_snapshot_get_value_details(
    s: &confeature::Snapshot,
) -> confeature::EvaluationDetails<bool> {
    s.get_value_details::<bool>("k", false, None)
}

fn pin_confeature_snapshot_get_all_values(
    s: &confeature::Snapshot,
) -> HashMap<String, confeature::Value> {
    s.get_all_values()
}

async fn probe_configcat_refresh(c: &ConfigCatClient) {
    let _ = c.refresh().await;
}

fn probe_confeature_builder() -> confeature::ClientBuilder {
    ConfeatureClient::builder("k")
}

fn probe_configcat_builder() -> configcat::ClientBuilder {
    ConfigCatClient::builder("k")
}

fn probe_confeature_close(c: ConfeatureClient) {
    c.close();
}

fn probe_confeature_snapshot(c: &ConfeatureClient) -> confeature::Snapshot {
    c.snapshot()
}

fn probe_confeature_builder_options(b: confeature::ClientBuilder) -> confeature::ClientBuilder {
    b.polling_mode(confeature::PollingMode::ManualPoll)
        .http_timeout(Duration::from_secs(5))
        .base_url("https://example.invalid".to_string())
}

fn probe_configcat_builder_options(b: configcat::ClientBuilder) -> configcat::ClientBuilder {
    b.polling_mode(configcat::PollingMode::Manual)
        .http_timeout(Duration::from_secs(5))
        .base_url("https://example.invalid")
}

#[test]
fn confeature_client_carries_core_evaluation_surface() {
    // The probes are never invoked — the test passes if the file
    // compiled at all. The runtime body re-anchors the symbols so a
    // dead-code lint can't strip them.
    let _ = probe_confeature_get_value as *const ();
    let _ = probe_configcat_get_value as *const ();
    let _ = probe_confeature_force_refresh as *const ();
    let _ = probe_configcat_refresh as *const ();
    let _ = probe_confeature_builder as *const ();
    let _ = probe_configcat_builder as *const ();
    let _ = probe_confeature_close as *const ();
    let _ = probe_confeature_snapshot as *const ();
    let _ = probe_confeature_builder_options as *const ();
    let _ = probe_configcat_builder_options as *const ();
}

// ── 3. Typed widening probes (spec 071 US1) ──────────────────────────
//
// The four-type evaluator widening unlocks `T: bool / String / i64 /
// f64` through the same generic `get_value` / `get_value_sync`. These
// probes pin the surface compile-time even without invoking the
// methods.

async fn probe_get_value_bool(c: &ConfeatureClient) -> bool {
    c.get_value::<bool>("k", false, None).await
}

async fn probe_get_value_string(c: &ConfeatureClient) -> String {
    c.get_value::<String>("k", "fallback".to_string(), None)
        .await
}

async fn probe_get_value_i64(c: &ConfeatureClient) -> i64 {
    c.get_value::<i64>("k", -1, None).await
}

async fn probe_get_value_f64(c: &ConfeatureClient) -> f64 {
    c.get_value::<f64>("k", 0.0, None).await
}

fn probe_get_value_sync_bool(c: &ConfeatureClient) -> bool {
    c.get_value_sync::<bool>("k", false, None)
}

fn probe_get_value_sync_string(c: &ConfeatureClient) -> String {
    c.get_value_sync::<String>("k", "fallback".to_string(), None)
}

fn probe_get_value_sync_i64(c: &ConfeatureClient) -> i64 {
    c.get_value_sync::<i64>("k", -1, None)
}

fn probe_get_value_sync_f64(c: &ConfeatureClient) -> f64 {
    c.get_value_sync::<f64>("k", 0.0, None)
}

#[test]
fn confeature_get_value_compiles_for_all_four_primitive_t() {
    let _ = probe_get_value_bool as *const ();
    let _ = probe_get_value_string as *const ();
    let _ = probe_get_value_i64 as *const ();
    let _ = probe_get_value_f64 as *const ();
    let _ = probe_get_value_sync_bool as *const ();
    let _ = probe_get_value_sync_string as *const ();
    let _ = probe_get_value_sync_i64 as *const ();
    let _ = probe_get_value_sync_f64 as *const ();
}

// ── 4. KNOWN DIVERGENCES — methods on ConfigCat ABSENT on Confeature ─
//
// Each ConfigCat method listed in `KNOWN_DIVERGENCES_264` is pinned
// against the official `configcat::Client` so that a ConfigCat-side
// removal surfaces here. The corresponding `confeature::Client` probe
// is intentionally *not written* — adding it would fail to compile,
// which is the inverse drift-signal we want for the #264 follow-on:
// when a method lands on `confeature::Client`, the operator writes
// the matching probe, the test compiles, and the entry is removed
// from the list.

async fn pin_configcat_get_flag_details(c: &ConfigCatClient) {
    let _ = c.get_flag_details("k", None).await;
}

async fn pin_configcat_get_all_value_details(c: &ConfigCatClient) {
    let _ = c.get_all_value_details(None).await;
}

async fn pin_configcat_get_all_keys(c: &ConfigCatClient) {
    let _ = c.get_all_keys().await;
}

fn pin_configcat_offline(c: &ConfigCatClient) {
    c.offline();
}

fn pin_configcat_online(c: &ConfigCatClient) {
    c.online();
}

fn pin_configcat_is_offline(c: &ConfigCatClient) -> bool {
    c.is_offline()
}

fn pin_configcat_set_default_user(c: &mut ConfigCatClient, u: configcat::User) {
    c.set_default_user(u);
}

fn pin_configcat_clear_default_user(c: &mut ConfigCatClient) {
    c.clear_default_user();
}

async fn pin_configcat_wait_for_ready(c: &ConfigCatClient) {
    let _ = c.wait_for_ready(Duration::from_secs(1)).await;
}

fn pin_configcat_new(k: &str) -> Result<ConfigCatClient, configcat::ClientError> {
    ConfigCatClient::new(k)
}

/// ConfigCat methods deferred to the spec-072+ follow-on (epic #264).
/// Each name MUST be absent on `confeature::Client` today. If a future
/// patch adds one, this file gains a `probe_confeature_<name>` async
/// fn (or `fn`) — the conformance test compiles, and the entry is
/// removed from this list.
///
/// NOTE: `offline` + `online` + `is_offline` moved to dedicated
/// presence probes under spec 095 / #267 slice 6/14. The matching
/// `pin_configcat_*` fns above remain — they still anchor the upstream
/// reference, and a removal there would surface as a compile failure.
const KNOWN_DIVERGENCES_264: &[(&str, &str)] = &[
    ("get_flag_details", "#264"),
    ("get_all_value_details", "#264"),
    ("get_all_keys", "#264"),
    ("wait_for_ready", "#264"),
    ("set_default_user", "#264 — mutable client API"),
    ("clear_default_user", "#264"),
    (
        "new",
        "#264 — DIVERGENCE-BY-DESIGN: Confeature exposes `builder()` only",
    ),
];

// The list itself is the drift-guard contract — at least one entry MUST
// remain until the #264 follow-on actually lands. Checked at compile time:
// the table is a constant, so a runtime assert on it is one clippy rejects
// (const_is_empty) and one that could only ever pass.
const _: () = assert!(
    !KNOWN_DIVERGENCES_264.is_empty(),
    "KNOWN_DIVERGENCES_264 is empty — if the #264 follow-on landed, \
     the present-method probes MUST also probe `confeature::Client`."
);

#[test]
fn known_divergences_264_are_pinned_against_configcat_reference() {
    // Compile-time sanity: every ConfigCat method named in the
    // divergence list still exists on the official `configcat::Client`
    // surface. If ConfigCat removes one, the corresponding `pin_*`
    // function above fails to compile and the divergence list is
    // reviewed.
    // NOTE: `pin_configcat_offline / online / is_offline` are still
    // referenced from `confeature_carries_online_offline_triplet` below
    // (the sibling presence test). They no longer participate in the
    // KNOWN_DIVERGENCES_264 array because spec 095 / #267 slice 6/14
    // landed the matching `confeature::Client` methods.
    let pins: &[*const ()] = &[
        pin_configcat_get_flag_details as *const (),
        pin_configcat_get_all_value_details as *const (),
        pin_configcat_get_all_keys as *const (),
        pin_configcat_set_default_user as *const (),
        pin_configcat_clear_default_user as *const (),
        pin_configcat_wait_for_ready as *const (),
        pin_configcat_new as *const (),
    ];
    assert_eq!(
        pins.len(),
        KNOWN_DIVERGENCES_264.len(),
        "the divergence table and the compile-time pin block must stay in lock-step"
    );

    for (name, issue) in KNOWN_DIVERGENCES_264 {
        assert!(
            !name.is_empty(),
            "divergence entry missing name (issue tag {issue})"
        );
    }
}

// ── 4b. Online/offline triplet — landed (spec 095 / #267 slice 6/14) ─

fn probe_confeature_offline(c: &ConfeatureClient) {
    c.offline();
}

fn probe_confeature_online(c: &ConfeatureClient) {
    c.online();
}

fn probe_confeature_is_offline(c: &ConfeatureClient) -> bool {
    c.is_offline()
}

#[test]
fn confeature_carries_online_offline_triplet() {
    // Compile-time presence — if any of `offline()` / `online()` /
    // `is_offline()` is removed or renamed on `confeature::Client`, this
    // file fails to compile. Drift-guard in the OPPOSITE direction from
    // the divergence list.
    let _ = probe_confeature_offline as *const ();
    let _ = probe_confeature_online as *const ();
    let _ = probe_confeature_is_offline as *const ();
    // Re-anchor the upstream symbols so the verb-form naming on both
    // sides stays in lock-step.
    let _ = pin_configcat_offline as *const ();
    let _ = pin_configcat_online as *const ();
    let _ = pin_configcat_is_offline as *const ();
}

// ── 5. Confeature superset surface — recorded but not required ───────

fn probe_confeature_get_value_sync(c: &ConfeatureClient) -> bool {
    // Sync evaluation is a Confeature addition — ConfigCat is async-
    // only. Recorded as a deliberate Confeature superset, not a
    // divergence.
    c.get_value_sync::<bool>("k", false, None)
}

#[test]
fn confeature_supersets_recorded() {
    let _ = probe_confeature_get_value_sync as *const ();
    // User type — both SDKs expose a `User`. Pin both anchors so a
    // drop on either side surfaces here.
    let _confeature_user: fn(String) -> User = User::new;
    // `configcat::User` is constructible too — we just take its size
    // to anchor the symbol.
    let _configcat_user_size: usize = std::mem::size_of::<configcat::User>();
}

// ── Spec 084 — newly-landed methods anchored on `confeature::Client` ─

#[test]
fn confeature_carries_get_value_details_and_get_all_values() {
    // Compile-time presence — if a method named on the spec-084
    // landing list is removed or renamed, this file fails to compile.
    let _ = pin_confeature_get_value_details as *const ();
    let _ = pin_confeature_get_all_values as *const ();
    let _ = pin_confeature_snapshot_get_value_details as *const ();
    let _ = pin_confeature_snapshot_get_all_values as *const ();
}

// PROOF (#913, FR-013): a deliberate break. This pull request is closed unmerged.
#[test]
fn proof_913() {
    assert_eq!(1, 2);
}
