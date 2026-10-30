// SPDX-License-Identifier: MIT

//! What a `wire-cases.json` case means for sdk-rust — ONE implementation,
//! shared by the hermetic suite (`tests/wire_cases.rs`, a raw-TCP mock)
//! AND the live suite (`tests/wire_cases_live.rs`, real HTTP against the
//! live-contract harness, #921), so both are judged by the same rules.
//! The request is passed in SDK-neutral form (path as sent, URL as sent,
//! If-None-Match): the hermetic suite reads it from the raw request line,
//! the live suite from the harness's `GET /admin/requests`.
//!
//! Mirrors sdk-python's `_wire_case_assertions.py` (#783, decision row 6)
//! and sdk-ruby's `wire_case_assertions.rb` (#920).

#![allow(dead_code)]

use confeature::__wire_test_api::{ConfigFetcher, FetchResult, FetchStatus};
use confeature::{LogFacadeLogger, LogLevel};
use serde::Deserialize;
use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

// ---------------------------------------------------------------------
// Corpus shape. `given` and `expected` DENY unknown fields (schema 1.3,
// #803 FR-003): a new expectation the Rust consumer does not read FAILS
// the suite instead of being skipped silently.
// ---------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct WireCorpus {
    pub cases: Vec<WireCase>,
}

#[derive(Debug, Deserialize)]
pub struct WireCase {
    pub id: String,
    #[serde(default)]
    pub description: String,
    pub given: WireGiven,
    pub server: WireServer,
    pub expected: WireExpected,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WireGiven {
    #[serde(rename = "previousEtag")]
    pub previous_etag: Option<String>,
    /// Non-default base URL (custom-base-url case, #336).
    #[serde(default, rename = "baseUrl")]
    pub base_url: Option<String>,
    /// The SDK key to configure (request-path cases, #803). Falls back to
    /// the suite's own default key when absent.
    #[serde(default, rename = "sdkKey")]
    pub sdk_key: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct WireServer {
    /// Selects how the mock transport acts (#490 / #590): "respond"
    /// (default, absent) delivers status+headers+body;
    /// "timeout" hangs past the client's request timeout; and
    /// "close-mid-response" drops the connection mid-body. An
    /// unrecognised value FAILS the case loudly (never falls through to
    /// respond). Mirrors sdk-go's `wireServer.Behavior` (commit a804507).
    #[serde(default)]
    pub behavior: Option<String>,
    pub status: u16,
    #[serde(default)]
    pub headers: std::collections::BTreeMap<String, String>,
    #[serde(default, rename = "bodyRef")]
    pub body_ref: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WireExpected {
    /// Three-state — see [`IfNoneMatchExpectation`] below.
    #[serde(default, rename = "requestHeaderIfNoneMatch")]
    pub request_header_if_none_match: IfNoneMatchExpectation,
    pub outcome: String,
    #[serde(default, rename = "resultingEtag")]
    pub resulting_etag: Option<String>,
    #[serde(default, rename = "errorClass")]
    pub error_class: Option<String>,
    #[serde(default, rename = "hasConfig")]
    pub has_config: Option<bool>,
    /// The outgoing URL starts with this (custom-base-url case, #336).
    #[serde(default, rename = "requestUrlPrefix")]
    pub request_url_prefix: Option<String>,
    /// The exact request path AS SENT, query excluded, compared byte for
    /// byte with the request line (#803 FR-003).
    #[serde(default, rename = "requestPath")]
    pub request_path: Option<String>,
}

/// Three-state semantics for `expected.requestHeaderIfNoneMatch`:
///
/// - **absent** (key not present in the case JSON) -> don't assert
///   anything about the outbound `If-None-Match` header.
/// - **explicit `null`** -> header MUST NOT be sent.
/// - **explicit string** -> header MUST equal that string.
#[derive(Debug, Default)]
pub enum IfNoneMatchExpectation {
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

/// The one request a fetch put on the wire, in the form both suites can
/// supply.
#[derive(Debug)]
pub struct SentRequest<'a> {
    /// The request target exactly as sent, query excluded.
    pub path: &'a str,
    /// The request target as sent, query included.
    pub url: &'a str,
    /// The `If-None-Match` value, `None` when the header was not sent.
    pub if_none_match: Option<&'a str>,
}

fn fixtures_dir() -> PathBuf {
    super::workspace_root()
        .join("packages")
        .join("test-fixtures-sdk-parity")
        .join("fixtures")
}

/// Body resolution — `bodyRef` reads a sibling fixture, `body` is raw.
pub fn resolve_body(case: &WireCase) -> Option<Vec<u8>> {
    if let Some(ref reference) = case.server.body_ref {
        let path = fixtures_dir().join(reference);
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

pub fn load_corpus() -> WireCorpus {
    let path = fixtures_dir().join("wire-cases.json");
    let raw = fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("read wire-cases.json from {}: {e}", path.display()));
    // Leniently first, so a case this reader cannot read yet is told apart
    // by its id (1.4, #994); then every other case strictly.
    let lenient: Value =
        serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parse wire-cases.json: {e}"));
    let mut pending = load_pending_cases();
    let mut cases = Vec::new();
    for raw_case in lenient["cases"]
        .as_array()
        .expect("wire-cases.json: cases[]")
    {
        let id = raw_case["id"]
            .as_str()
            .expect("a wire case has an id")
            .to_owned();
        let decoded = WireCase::deserialize(raw_case);
        if let Some(ticket) = pending.remove(&id) {
            // The proof that the entry is still true: this reader still
            // cannot read the case. The day it can, the entry must go.
            match decoded {
                Ok(_) => panic!(
                    "{id} is pending for sdk-rust ({ticket}) but this reader reads every field of it \
                     — remove it from wire-cases-pending.json and run it"
                ),
                Err(e) => eprintln!("pending ({ticket}): {id} — this reader cannot read it yet: {e}"),
            }
            continue;
        }
        cases.push(decoded.unwrap_or_else(|e| panic!("parse wire case {id}: {e}")));
    }
    if let Some(id) = pending.keys().next() {
        panic!("wire-cases-pending.json lists {id} for sdk-rust, but the corpus has no such case");
    }
    assert!(!cases.is_empty(), "wire-cases.json carries no cases");
    WireCorpus { cases }
}

/// sdk-rust's entry of `wire-cases-pending.json` (1.4, #994): case id ->
/// ticket. An absent entry is the empty set — the reader runs every case.
pub fn load_pending_cases() -> std::collections::BTreeMap<String, String> {
    let path = fixtures_dir().join("wire-cases-pending.json");
    let raw = fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("read wire-cases-pending.json from {}: {e}", path.display()));
    let manifest: Value =
        serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parse wire-cases-pending.json: {e}"));
    let entry = &manifest["pending"]["sdk-rust"];
    let ticket = entry["ticket"].as_str().unwrap_or_default().to_owned();
    entry["cases"]
        .as_array()
        .map(|ids| {
            ids.iter()
                .map(|id| {
                    (
                        id.as_str().expect("a pending case id").to_owned(),
                        ticket.clone(),
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The fetcher's fixed, key-free transport reasons (#803 FR-002,
/// `classify_reqwest_error`): each is a fetchFailed. Named, so an unknown
/// reason is NOT one.
const TRANSPORT_FAILURES: &[&str] = &[
    "redirect_error",
    "connect_error",
    "body_read_failed",
    "builder_error",
    "request_error",
    "fetch_failed",
];

/// Maps the fetcher's `FetchResult.error` reason codes onto the corpus's
/// error-class vocabulary — "MALFORMED_JSON" → parseFailed; "HTTP 403" /
/// "HTTP 404" / "INVALID_SDK_KEY" → invalidSdkKey (per ConfigCat only
/// 403/404 are invalid-SDK-key statuses, #512); any other "HTTP <status>"
/// and [`TRANSPORT_FAILURES`] → fetchFailed; "timeout" → timeout.
///
/// Fails closed, like sdk-python's `python_error_to_class`: anything else —
/// a missing reason included — maps to `unmapped:<reason>`, which matches
/// no corpus class. Folding the unknown into fetchFailed would let any
/// unexpected failure pass every fetchFailed case.
pub fn rust_error_to_class(error: Option<&str>) -> String {
    match error {
        Some("MALFORMED_JSON") => "parseFailed".into(),
        Some("HTTP 403") | Some("HTTP 404") | Some("INVALID_SDK_KEY") => "invalidSdkKey".into(),
        Some("timeout") => "timeout".into(),
        Some(s) if s.starts_with("HTTP ") || TRANSPORT_FAILURES.contains(&s) => {
            "fetchFailed".into()
        }
        other => format!("unmapped:{other:?}"),
    }
}

/// The key a suite configures its fetcher with: the corpus's
/// `given.sdkKey` when the case pins one, else the suite's own default
/// (the live suite's default is the case id, the key the harness seeds).
pub fn sdk_key_for<'a>(case: &'a WireCase, default_key: &'a str) -> &'a str {
    case.given.sdk_key.as_deref().unwrap_or(default_key)
}

/// The exact path a case's request must carry (#803 FR-001): the corpus's
/// `requestPath` when the case pins one, else ConfigCat's
/// `/configuration-files/<sdkKey>/config_v6.json` with the key verbatim —
/// which is how a suite proves the SDK sent the key it was configured with.
/// Both default keys (a legacy-shaped key offline, a case id live) are
/// sent verbatim.
pub fn request_path_for(case: &WireCase, sdk_key: &str) -> String {
    case.expected
        .request_path
        .clone()
        .unwrap_or_else(|| format!("/configuration-files/{sdk_key}/config_v6.json"))
}

/// Judges one fetch of `case` — the request it sent and the result it
/// returned — by the corpus's expectations.
pub fn assert_wire_case(case: &WireCase, sdk_key: &str, sent: &SentRequest, result: &FetchResult) {
    assert_request(case, sdk_key, sent);
    assert_outcome(case, result);
}

/// `expected.requestUrlPrefix` (custom-base-url, #336): a fetcher
/// configured with `given.baseUrl` must target a URL starting with the
/// prefix. Checked on [`ConfigFetcher::url`] — the one function that forms
/// the URL `fetch` GETs — because the case's host is not routable from a
/// test.
fn assert_request_url_prefix(case: &WireCase, sdk_key: &str) {
    let Some(prefix) = &case.expected.request_url_prefix else {
        return;
    };
    let base =
        case.given.base_url.clone().unwrap_or_else(|| {
            panic!("case {:?}: requestUrlPrefix without given.baseUrl", case.id)
        });
    let fetcher = ConfigFetcher::new(
        Some(base),
        sdk_key.to_string(),
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

/// The request side: the exact path as sent (compared byte for byte), no
/// legacy `/v2/` prefix, the custom base URL, and the If-None-Match
/// round-trip.
pub fn assert_request(case: &WireCase, sdk_key: &str, sent: &SentRequest) {
    assert_eq!(
        sent.path,
        request_path_for(case, sdk_key),
        "case {:?}: request path on the wire mismatch (target {:?})",
        case.id,
        sent.url
    );
    assert!(
        !sent.url.contains("/v2/"),
        "case {:?}: URL {} carries the legacy /v2/ prefix",
        case.id,
        sent.url
    );
    assert_request_url_prefix(case, sdk_key);

    match &case.expected.request_header_if_none_match {
        IfNoneMatchExpectation::Absent => { /* don't assert */ }
        IfNoneMatchExpectation::Null => {
            assert!(
                sent.if_none_match.is_none(),
                "case {:?}: previousEtag=null MUST NOT send If-None-Match; got {:?}",
                case.id,
                sent.if_none_match
            );
        }
        IfNoneMatchExpectation::Value(expected) => {
            assert_eq!(
                sent.if_none_match,
                Some(expected.as_str()),
                "case {:?}: If-None-Match mismatch",
                case.id
            );
        }
    }
}

/// The outcome side: maps the fetcher's typed status + reason code onto the
/// corpus's `{fetched, notModified, failed}` x errorClass vocabulary, and
/// checks `hasConfig`.
pub fn assert_outcome(case: &WireCase, result: &FetchResult) {
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
            assert_resulting_etag(case, result);
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
            assert_resulting_etag(case, result);
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

fn assert_resulting_etag(case: &WireCase, result: &FetchResult) {
    if let Some(expected) = &case.expected.resulting_etag {
        assert_eq!(
            result.etag.as_deref(),
            Some(expected.as_str()),
            "case {:?}: resulting ETag mismatch",
            case.id
        );
    }
}
