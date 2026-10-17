// SPDX-License-Identifier: MIT

//! Wire-protocol fixture suite (Rust consumer).
//!
//! Drives sdk-rust's `internal::config_fetcher::ConfigFetcher` (exposed
//! via the `#[doc(hidden)]` `confeature::__wire_test_api` re-export)
//! against each case in
//! `packages/test-fixtures-sdk-parity/fixtures/wire-cases.json`. The
//! corpus is the language-agnostic contract; this file is the Rust
//! consumer that maps the fetcher's typed `FetchStatus` + stringly-
//! typed `FetchResult.error` onto the corpus's normalised
//! `{fetched, notModified, failed}` x `{fetchFailed, timeout,
//! parseFailed, invalidSdkKey}` vocabulary — the same mapping
//! sdk-node / sdk-browser-js / sdk-bun / sdk-deno / sdk-python / sdk-go
//! already conform to.
//!
//! Layer choice: this drives the fetcher directly (NOT the public
//! `Client`), matching what the five JS-family consumers + sdk-python +
//! sdk-go already do — the wire-cases corpus by name tests wire
//! behaviour, and the fetcher is sdk-rust's wire layer. Driving the
//! public `Client` would add poll-service indirection (cache writes,
//! AutoPoll ticker hooks) that the corpus does not assert.
//!
//! See epic #146 (contract testing framework) + #148 slice 5 + spec 112.
//!
//! The expectation rules live in `common::wire_case`, shared with the live
//! suite (`tests/wire_cases_live.rs`, #921): this file supplies only the
//! hermetic transport.

mod common;

use common::raw_http::{Behavior, RawServer};
use common::wire_case::{
    assert_wire_case, load_corpus, resolve_body, rust_error_to_class, sdk_key_for, SentRequest,
    WireCase,
};
use confeature::__wire_test_api::{ConfigFetcher, FetchResult};
use confeature::{LogFacadeLogger, LogLevel};
use std::sync::Arc;
use std::time::Duration;

const WIRE_TEST_SDK_KEY: &str =
    "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

/// The error-class mapping fails closed (#921, as sdk-ruby/sdk-php did in
/// #920): a missing or unknown reason matches no corpus class, so it can
/// never pass a fetchFailed case by default.
#[test]
fn error_mapping_fails_closed() {
    assert_eq!(rust_error_to_class(None), "unmapped:None");
    assert_eq!(
        rust_error_to_class(Some("something_new")),
        "unmapped:Some(\"something_new\")"
    );
    for reason in [
        "connect_error",
        "body_read_failed",
        "request_error",
        "HTTP 503",
    ] {
        assert_eq!(rust_error_to_class(Some(reason)), "fetchFailed", "{reason}");
    }
    assert_eq!(rust_error_to_class(Some("HTTP 403")), "invalidSdkKey");
    assert_eq!(rust_error_to_class(Some("timeout")), "timeout");
}

// ---------------------------------------------------------------------
// Test driver. Each case lands as a sub-assertion under a single
// `#[tokio::test]` driver (mirrors `parity_corpus.rs`'s pattern — Rust's
// integration test runner doesn't surface dynamically-named tests with
// the ergonomics of Go's `t.Run` / pytest's parametrise).
// ---------------------------------------------------------------------
#[tokio::test(flavor = "current_thread")]
async fn wire_cases_conformance() {
    let corpus = load_corpus();

    for case in &corpus.cases {
        run_case(case).await;
    }
}

/// Dispatches on `server.behavior` (#590), mirroring sdk-go's switch
/// (commit a804507): absent / "respond" serves the case's response,
/// "timeout" never answers, "close-mid-response" drops the connection
/// mid-body; anything else FAILS loudly (never falls through to respond —
/// FR-008 guard).
///
/// Every behaviour runs on the raw-TCP server of `common::raw_http`, which
/// records the request line AS RECEIVED: the request-side assertions see
/// the bytes the SDK put on the wire, never a mock's parsed or re-encoded
/// view of them (#803 — `expected.requestPath` is compared byte for byte).
async fn run_case(case: &WireCase) {
    let body = resolve_body(case).unwrap_or_default();
    let headers: Vec<(String, String)> = case
        .server
        .headers
        .iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    let behavior = case.server.behavior.as_deref().unwrap_or("respond");
    let (server_behavior, request_timeout) = match behavior {
        "respond" => (
            Behavior::Respond {
                status: case.server.status,
                headers,
                body,
            },
            Duration::from_secs(1),
        ),
        // A short deadline keeps the suite fast.
        "timeout" => (Behavior::Hang, Duration::from_millis(200)),
        // A truncated body is a transport failure → fetchFailed, NOT
        // parseFailed. Mirrors sdk-go's hijack path.
        "close-mid-response" => (
            Behavior::CloseMidBody { headers, body },
            Duration::from_secs(1),
        ),
        other => panic!(
            "case {:?}: unsupported server.behavior {:?} — no adapter (never \
             fall through to respond)",
            case.id, other
        ),
    };
    let mut server = RawServer::start(server_behavior).await;

    let sdk_key = sdk_key_for(case, WIRE_TEST_SDK_KEY);
    let fetcher = ConfigFetcher::new(
        Some(server.base_url.clone()),
        sdk_key.to_string(),
        "0.0.0-wire-test",
        Some(request_timeout),
        None,
        Arc::new(LogFacadeLogger::new(LogLevel::Off)),
    )
    .expect("ConfigFetcher::new");

    let prev_etag = case.given.previous_etag.as_deref();
    let result: FetchResult = fetcher.fetch(prev_etag).await;

    let requests = server.requests();
    assert_eq!(
        requests.len(),
        1,
        "case {:?}: fetcher MUST issue exactly one HTTP request (got {:?})",
        case.id,
        requests
    );
    let raw = &requests[0];
    let sent = SentRequest {
        path: raw.path(),
        url: raw.target(),
        if_none_match: raw.header("if-none-match"),
    };
    assert_wire_case(case, sdk_key, &sent, &result);
}
