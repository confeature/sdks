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

mod common;

use common::raw_http::{Behavior, RawRequest, RawServer};
use confeature::__wire_test_api::{ConfigFetcher, FetchResult, FetchStatus};
use confeature::{LogFacadeLogger, LogLevel};
use serde::Deserialize;
use serde_json::Value;
use std::fs;
use std::sync::Arc;
use std::time::Duration;

const WIRE_TEST_SDK_KEY: &str =
    "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

// ---------------------------------------------------------------------
// Corpus shape. `given` and `expected` DENY unknown fields (schema 1.3,
// #803 FR-003): a new expectation the Rust consumer does not read FAILS
// the suite instead of being skipped silently.
// ---------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct WireCorpus {
    cases: Vec<WireCase>,
}

#[derive(Debug, Deserialize)]
struct WireCase {
    id: String,
    #[serde(default)]
    #[allow(dead_code)]
    description: String,
    given: WireGiven,
    server: WireServer,
    expected: WireExpected,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WireGiven {
    #[serde(rename = "previousEtag")]
    previous_etag: Option<String>,
    /// Non-default base URL (custom-base-url case, #336).
    #[serde(default, rename = "baseUrl")]
    base_url: Option<String>,
    /// The SDK key to configure (request-path cases, #803). Falls back to
    /// [`WIRE_TEST_SDK_KEY`] when absent.
    #[serde(default, rename = "sdkKey")]
    sdk_key: Option<String>,
}

#[derive(Debug, Deserialize)]
struct WireServer {
    /// Selects how the mock transport acts (#490 / #590): "respond"
    /// (default, absent) delivers status+headers+body;
    /// "timeout" hangs past the client's request timeout; and
    /// "close-mid-response" drops the connection mid-body. An
    /// unrecognised value FAILS the case loudly (never falls through to
    /// respond). Mirrors sdk-go's `wireServer.Behavior` (commit a804507).
    #[serde(default)]
    behavior: Option<String>,
    status: u16,
    #[serde(default)]
    headers: std::collections::BTreeMap<String, String>,
    #[serde(default, rename = "bodyRef")]
    body_ref: Option<String>,
    #[serde(default)]
    body: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WireExpected {
    /// Three-state — see [`IfNoneMatchExpectation`] below.
    #[serde(default, rename = "requestHeaderIfNoneMatch")]
    request_header_if_none_match: IfNoneMatchExpectation,
    outcome: String,
    #[serde(default, rename = "resultingEtag")]
    resulting_etag: Option<String>,
    #[serde(default, rename = "errorClass")]
    error_class: Option<String>,
    #[serde(default, rename = "hasConfig")]
    has_config: Option<bool>,
    /// The outgoing URL starts with this (custom-base-url case, #336).
    #[serde(default, rename = "requestUrlPrefix")]
    request_url_prefix: Option<String>,
    /// The exact request path AS SENT, query excluded, compared byte for
    /// byte with the raw request line (#803 FR-003).
    #[serde(default, rename = "requestPath")]
    request_path: Option<String>,
}

/// Three-state semantics for `expected.requestHeaderIfNoneMatch`:
///
/// - **absent** (key not present in the case JSON) -> don't assert
///   anything about the outbound `If-None-Match` header.
/// - **explicit `null`** -> header MUST NOT be sent.
/// - **explicit string** -> header MUST equal that string.
#[derive(Debug, Default)]
enum IfNoneMatchExpectation {
    #[default]
    Absent,
    Null,
    Value(String),
}

impl<'de> Deserialize<'de> for IfNoneMatchExpectation {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        // serde calls `deserialize` only when the key IS present (Absent
        // falls through `#[serde(default)]`). So we only see Null or
        // String here.
        let v = Option::<String>::deserialize(deserializer)?;
        Ok(match v {
            Some(s) => IfNoneMatchExpectation::Value(s),
            None => IfNoneMatchExpectation::Null,
        })
    }
}

// ---------------------------------------------------------------------
// Body resolution — `bodyRef` reads a sibling fixture, `body` is raw.
// ---------------------------------------------------------------------

fn resolve_body(case: &WireCase) -> Option<Vec<u8>> {
    if let Some(ref reference) = case.server.body_ref {
        let path = common::workspace_root()
            .join("packages")
            .join("test-fixtures-sdk-parity")
            .join("fixtures")
            .join(reference);
        let raw = fs::read(&path).unwrap_or_else(|e| {
            panic!(
                "wire_cases: failed to read bodyRef {} from {}: {e}",
                reference,
                path.display()
            )
        });
        return Some(raw);
    }
    case.server.body.as_ref().map(|s| s.as_bytes().to_vec())
}

fn load_corpus() -> WireCorpus {
    let path = common::workspace_root()
        .join("packages")
        .join("test-fixtures-sdk-parity")
        .join("fixtures")
        .join("wire-cases.json");
    let raw = fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("read wire-cases.json from {}: {e}", path.display()));
    let corpus: WireCorpus =
        serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parse wire-cases.json: {e}"));
    assert!(
        !corpus.cases.is_empty(),
        "wire-cases.json carries no cases — fixture is FROZEN at 12 cases"
    );
    corpus
}

// ---------------------------------------------------------------------
// Error-class mapping — `FetchResult.error` strings -> corpus vocabulary.
// Mirrors `_python_error_to_class` (apps/sdk-python/tests/wire/
// test_wire_cases.py) and sdk-go's `goErrorToClass`. When the fetcher
// switches to a typed error enum, this becomes a `match` on the enum.
// ---------------------------------------------------------------------
fn rust_error_to_class(error: Option<&str>) -> &'static str {
    match error {
        None => "fetchFailed",
        Some("MALFORMED_JSON") => "parseFailed",
        // Per ConfigCat only 403/404 are invalid-SDK-key statuses (401 is a
        // generic retryable failure). See #512.
        Some("HTTP 403") | Some("HTTP 404") => "invalidSdkKey",
        Some(s) if s.starts_with("HTTP ") => "fetchFailed",
        Some("INVALID_SDK_KEY") => "invalidSdkKey",
        Some("timeout") => "timeout",
        _ => "fetchFailed",
    }
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

    let fetcher = ConfigFetcher::new(
        Some(server.base_url.clone()),
        sdk_key_for(case).to_string(),
        "0.0.0-wire-test",
        Some(request_timeout),
        None,
        Arc::new(LogFacadeLogger::new(LogLevel::Off)),
    )
    .expect("ConfigFetcher::new");

    let prev_etag = case.given.previous_etag.as_deref();
    let result: FetchResult = fetcher.fetch(prev_etag).await;

    // ---- Request-side assertions ------------------------------------
    let requests = server.requests();
    assert_eq!(
        requests.len(),
        1,
        "case {:?}: fetcher MUST issue exactly one HTTP request (got {:?})",
        case.id,
        requests
    );
    assert_request_side(case, &requests[0]);

    // ---- Outcome assertions -----------------------------------------
    assert_outcome(case, &result);
}

/// The SDK key a case configures: `given.sdkKey` when present (#803).
fn sdk_key_for(case: &WireCase) -> &str {
    case.given.sdk_key.as_deref().unwrap_or(WIRE_TEST_SDK_KEY)
}

/// `expected.requestUrlPrefix` (custom-base-url, #336): a fetcher
/// configured with `given.baseUrl` must target a URL starting with the
/// prefix. Checked on [`ConfigFetcher::url`] — the one function that forms
/// the URL `fetch` GETs — because the case's host is not routable from the
/// test; the round-trip itself runs against the mock.
fn assert_request_url_prefix(case: &WireCase) {
    let Some(prefix) = &case.expected.request_url_prefix else {
        return;
    };
    let base =
        case.given.base_url.clone().unwrap_or_else(|| {
            panic!("case {:?}: requestUrlPrefix without given.baseUrl", case.id)
        });
    let fetcher = ConfigFetcher::new(
        Some(base),
        sdk_key_for(case).to_string(),
        "0.0.0-wire-test",
        None,
        None,
        Arc::new(LogFacadeLogger::new(LogLevel::Off)),
    )
    .expect("ConfigFetcher::new");
    let url = fetcher.url().expect("a configured key has a URL");
    assert!(
        url.starts_with(prefix.as_str()),
        "case {:?}: URL {} does not start with {}",
        case.id,
        url,
        prefix
    );
}

/// Shared request-side assertions: the RAW request path (byte-exact when
/// the case pins `expected.requestPath`) + the custom base URL +
/// If-None-Match round-trip. Runs identically for every behaviour.
fn assert_request_side(case: &WireCase, captured: &RawRequest) {
    let path = captured.path();
    match &case.expected.request_path {
        Some(expected) => assert_eq!(
            path, expected,
            "case {:?}: request path on the wire mismatch (request line {:?})",
            case.id, captured.request_line
        ),
        None => assert!(
            path.starts_with("/configuration-files/") && path.ends_with("/config_v6.json"),
            "case {:?}: path {} is not /configuration-files/<sdkKey>/config_v6.json",
            case.id,
            path
        ),
    }
    assert_request_url_prefix(case);

    let if_none_match = captured.header("if-none-match");
    match &case.expected.request_header_if_none_match {
        IfNoneMatchExpectation::Absent => { /* don't assert */ }
        IfNoneMatchExpectation::Null => {
            assert!(
                if_none_match.is_none(),
                "case {:?}: previousEtag=null MUST NOT send If-None-Match; got {:?}",
                case.id,
                if_none_match
            );
        }
        IfNoneMatchExpectation::Value(expected) => {
            assert_eq!(
                if_none_match,
                Some(expected.as_str()),
                "case {:?}: If-None-Match mismatch",
                case.id
            );
        }
    }
}

/// Shared outcome assertions: maps the fetcher's typed status + stringly
/// error onto the corpus's `{fetched, notModified, failed}` x errorClass
/// vocabulary. Runs identically for every behaviour.
fn assert_outcome(case: &WireCase, result: &FetchResult) {
    if let Some(has_config) = case.expected.has_config {
        assert_eq!(
            result.body.is_some(),
            has_config,
            "case {:?}: hasConfig mismatch (status={:?})",
            case.id,
            result.status
        );
    }
    match case.expected.outcome.as_str() {
        "fetched" => {
            assert_eq!(
                result.status,
                FetchStatus::Fetched,
                "case {:?}: expected outcome=fetched, got status={:?} error={:?}",
                case.id,
                result.status,
                result.error
            );
            assert!(
                result.body.is_some(),
                "case {:?}: fetched outcome MUST carry a body",
                case.id
            );
            // Sanity-check the body is the parsed config-v6 shape.
            if let Some(Value::Object(ref obj)) = result.body {
                assert!(
                    obj.contains_key("f"),
                    "case {:?}: parsed body missing 'f' key",
                    case.id
                );
            }
            if let Some(expected) = &case.expected.resulting_etag {
                assert_eq!(
                    result.etag.as_deref(),
                    Some(expected.as_str()),
                    "case {:?}: resulting ETag mismatch",
                    case.id
                );
            }
        }
        "notModified" => {
            assert_eq!(
                result.status,
                FetchStatus::NotModified,
                "case {:?}: expected outcome=notModified, got status={:?} error={:?}",
                case.id,
                result.status,
                result.error
            );
            assert!(
                result.body.is_none(),
                "case {:?}: notModified outcome MUST NOT carry a body",
                case.id
            );
            if let Some(expected) = &case.expected.resulting_etag {
                assert_eq!(
                    result.etag.as_deref(),
                    Some(expected.as_str()),
                    "case {:?}: notModified resulting ETag mismatch",
                    case.id
                );
            }
        }
        "failed" => {
            assert_eq!(
                result.status,
                FetchStatus::Failed,
                "case {:?}: expected outcome=failed, got status={:?} body={:?}",
                case.id,
                result.status,
                result.body
            );
            let expected_class = case
                .expected
                .error_class
                .as_deref()
                .expect("failed outcome MUST carry errorClass in the corpus");
            let mapped = rust_error_to_class(result.error.as_deref());
            assert_eq!(
                mapped, expected_class,
                "case {:?}: errorClass mismatch (mapped from raw error={:?})",
                case.id, result.error
            );
        }
        other => panic!("case {:?}: unknown outcome {:?} in corpus", case.id, other),
    }
}
