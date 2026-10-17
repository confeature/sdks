// SPDX-License-Identifier: MIT

//! sdk-rust live wire-cases (#921, after sdk-python's #783).
//!
//! sdk-rust's own `ConfigFetcher` — its real reqwest stack — against a
//! RUNNING live-contract harness serving the reference origin of the CDN
//! read path. Every seeded wire-case is replayed and judged by
//! `common::wire_case::assert_wire_case`, the SAME rules the hermetic suite
//! (`tests/wire_cases.rs`) applies to a raw-TCP mock. Nothing is hand-built
//! here and no admin write is made:
//!
//! - the case set comes from the running harness (`GET /admin/state` →
//!   `keys`), never recomputed from the corpus and the seeds directory —
//!   `http-403` among them, an unseeded key answered by the Worker itself;
//! - the request each case sent is read back from the harness
//!   (`GET /admin/requests?sdkKey=`), so the key and If-None-Match are
//!   asserted on the wire, and each fetch must add exactly one entry;
//! - a timeout case is ended by the SDK's OWN deadline (the fetcher's
//!   timeout, a quarter of the harness's hold);
//! - US4: one unseeded key reaches the Worker's own unknown-key answer.
//!
//! Run it through the harness wrapper, the one agreed boot (the manifest's
//! `liveSuite.runner`):
//!
//! ```text
//! node tools/test-harness-live-contract/dist/cli.js --corpus-seed \
//!   --exec -- bash -c 'cd apps/sdk-rust && cargo test --test wire_cases_live'
//! ```
//!
//! GATING (fail closed): skipped only when `CONFEATURE_LIVE` is unset — the
//! hermetic `cargo test`, where it returns at once. When it is set without
//! `LIVE_HARNESS_URL`, or the harness does not answer, the test FAILS; it
//! never skips. Each case runs in its own task, so one failing case does
//! not hide the others: every failure is reported, then the test fails.

mod common;

use common::wire_case::{
    assert_wire_case, load_corpus, rust_error_to_class, sdk_key_for, SentRequest, WireCase,
};
use confeature::__wire_test_api::{ConfigFetcher, FetchStatus};
use confeature::{LogFacadeLogger, LogLevel};
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

const SDK_VERSION: &str = "0.0.0-live-wire";

/// The part of `GET /admin/state` this suite reads.
#[derive(Debug, Deserialize)]
struct HarnessState {
    keys: Vec<String>,
    #[serde(default)]
    faults: HashMap<String, Value>,
}

/// One entry of the harness's request log.
#[derive(Debug, Deserialize)]
struct HarnessRequest {
    url: String,
    #[serde(rename = "ifNoneMatch")]
    if_none_match: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RequestLog {
    ok: bool,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    requests: Vec<HarnessRequest>,
}

/// The running harness the suite reads from.
#[derive(Clone)]
struct Harness {
    base: String,
    http: reqwest::Client,
}

impl Harness {
    async fn get_json<T: for<'de> Deserialize<'de>>(&self, path: &str, sdk_key: Option<&str>) -> T {
        let mut request = self.http.get(format!("{}{path}", self.base));
        if let Some(key) = sdk_key {
            request = request.query(&[("sdkKey", key)]);
        }
        let response = request
            .send()
            .await
            .unwrap_or_else(|e| panic!("harness {path}: {e}"));
        let status = response.status();
        let body = response
            .text()
            .await
            .unwrap_or_else(|e| panic!("harness {path}: read body: {e}"));
        assert!(
            status.is_success(),
            "harness {path} answered {status}: {body}"
        );
        serde_json::from_str(&body).unwrap_or_else(|e| panic!("harness {path}: {e}: {body}"))
    }

    /// The requests the harness logged for `sdk_key`, oldest first.
    async fn requests_for(&self, sdk_key: &str) -> Vec<HarnessRequest> {
        let log: RequestLog = self.get_json("/admin/requests", Some(sdk_key)).await;
        assert!(log.ok, "harness refused /admin/requests: {:?}", log.error);
        log.requests
    }
}

fn fetcher(base: &str, sdk_key: &str, timeout: Duration) -> ConfigFetcher {
    ConfigFetcher::new(
        Some(base.to_string()),
        sdk_key.to_string(),
        SDK_VERSION,
        Some(timeout),
        None,
        Arc::new(LogFacadeLogger::new(LogLevel::Off)),
    )
    .expect("ConfigFetcher::new")
}

/// The harness's hold for a timeout case — the SDK's deadline is derived
/// from it (#783 A8) — or `None` for any other behaviour.
fn hold_for(case: &WireCase, state: &HarnessState) -> Option<Duration> {
    if case.server.behavior.as_deref() != Some("timeout") {
        return None;
    }
    let ms = state
        .faults
        .get(&case.id)
        .and_then(|fault| fault.get("ms"))
        .and_then(Value::as_u64)
        .unwrap_or_else(|| panic!("{} is seeded without a timeout fault", case.id));
    Some(Duration::from_millis(ms))
}

/// Replays one seeded case and judges it.
async fn run_live_case(harness: Harness, case: WireCase, hold: Option<Duration>) {
    // The harness seeds each case under its id; a case that pins
    // given.sdkKey is configured with that key instead (#803 FR-003).
    let sdk_key = sdk_key_for(&case, &case.id).to_string();
    let logged_before = harness.requests_for(&sdk_key).await.len();
    let deadline = hold.map_or(Duration::from_secs(10), |h| h / 4);
    let started = Instant::now();
    let result = fetcher(&harness.base, &sdk_key, deadline)
        .fetch(case.given.previous_etag.as_deref())
        .await;
    let elapsed = started.elapsed();

    let log = harness.requests_for(&sdk_key).await;
    // Exactly one request per fetch: a retrying SDK, or a request logged by
    // an earlier run, must not stand in for the one under test.
    assert_eq!(
        log.len() - logged_before,
        1,
        "case {:?}: requests sent by one fetch",
        case.id
    );
    if let Some(hold) = hold {
        // The SDK's own deadline ended the fetch, not the harness releasing it.
        assert!(
            elapsed < hold,
            "case {:?}: took {elapsed:?}, the harness holds for {hold:?}",
            case.id
        );
    }
    let last = log.last().expect("one request was logged");
    let sent = SentRequest {
        path: last.url.split('?').next().unwrap_or(&last.url),
        url: &last.url,
        if_none_match: last.if_none_match.as_deref(),
    };
    assert_wire_case(&case, &sdk_key, &sent, &result);
}

#[tokio::test(flavor = "multi_thread")]
async fn wire_cases_live() {
    if std::env::var("CONFEATURE_LIVE").as_deref() != Ok("1") {
        eprintln!("wire_cases_live: skipped — hermetic run, CONFEATURE_LIVE is not set");
        return;
    }
    let base = std::env::var("LIVE_HARNESS_URL").unwrap_or_default();
    let base = base.trim_end_matches('/').to_string();
    assert!(
        !base.is_empty(),
        "CONFEATURE_LIVE=1 but LIVE_HARNESS_URL is not set — run through \
         `live-contract-harness --corpus-seed --exec -- …`; a live suite must never pass by skipping"
    );
    let harness = Harness {
        base,
        http: reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .expect("harness client"),
    };
    let state: HarnessState = harness.get_json("/admin/state", None).await;
    let mut case_ids = state.keys.clone();
    case_ids.sort();
    assert!(
        !case_ids.is_empty(),
        "the harness reports no seeded case — an empty run checks nothing"
    );
    let mut corpus: HashMap<String, WireCase> = load_corpus()
        .cases
        .into_iter()
        .map(|case| (case.id.clone(), case))
        .collect();

    let mut failures = Vec::new();
    for id in &case_ids {
        let Some(case) = corpus.remove(id) else {
            failures.push(format!("{id}: seeded, but missing from the corpus"));
            continue;
        };
        let hold = hold_for(&case, &state);
        // Its own task: a panicking case fails alone, the others still run.
        match tokio::spawn(run_live_case(harness.clone(), case, hold)).await {
            Ok(()) => eprintln!("wire_cases_live: {id} ok"),
            Err(e) => failures.push(format!("{id}: {e}")),
        }
    }

    // US4: no seed, no fault — the CDN's own unknown-key answer, ConfigCat's
    // 403 since #785, classed like a 404 as invalidSdkKey.
    let unseeded = fetcher(&harness.base, "never-seeded-921", Duration::from_secs(10))
        .fetch(None)
        .await;
    if unseeded.status != FetchStatus::Failed
        || rust_error_to_class(unseeded.error.as_deref()) != "invalidSdkKey"
    {
        failures.push(format!(
            "unseeded key: status={:?} error={:?}; want failed / invalidSdkKey",
            unseeded.status, unseeded.error
        ));
    }

    assert!(
        failures.is_empty(),
        "{} of {} live checks failed (each case's panic is printed above):\n{}",
        failures.len(),
        case_ids.len() + 1,
        failures.join("\n")
    );
}
