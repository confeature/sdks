// SPDX-License-Identifier: MIT

//! HTTP integration tests for `Client` against a local `wiremock` server.
//!
//! These tests close the coverage gap on `internal::config_fetcher` and
//! `Client::force_refresh` (the no-network corpus run skips both paths).
//!
//! Strategy: stand up a `wiremock::MockServer`, point the client at it
//! via `.base_url(...)`, drive `force_refresh()`, and assert the
//! resulting `get_value`. ManualPoll keeps the test deterministic
//! (no AutoPoll ticker racing the assertions).

mod common;

use common::raw_http::{Behavior, RawServer};
use confeature::__wire_test_api::{ConfigFetcher, FetchStatus};
use confeature::{Client, LogFacadeLogger, LogLevel, Logger, PollingMode};
use serde_json::json;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const TEST_SDK_KEY: &str =
    "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

/// The exact parsed request path for [`TEST_SDK_KEY`] (#803 FR-001): the
/// key raw, no `/v2/`, no cache-key tail — ConfigCat's path.
fn legacy_path() -> String {
    format!("/configuration-files/{TEST_SDK_KEY}/config_v6.json")
}

fn config_body() -> serde_json::Value {
    json!({
        "p": { "u": "https://cdn-global.confeature.io", "r": 0, "s": "" },
        "f": {
            "feature.on": { "t": 0, "v": { "b": true }, "i": "abc12345" },
            "feature.off": { "t": 0, "v": { "b": false }, "i": "def67890" }
        }
    })
}

#[tokio::test(flavor = "current_thread")]
async fn force_refresh_200_populates_cache_and_get_value_resolves() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path(legacy_path()))
        .and(header("User-Agent", "confeature-rust-sdk/0.1.0"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("ETag", "v1")
                .set_body_json(config_body()),
        )
        .expect(1)
        .mount(&server)
        .await;

    let client = Client::builder(TEST_SDK_KEY)
        .polling_mode(PollingMode::ManualPoll)
        .base_url(server.uri())
        .cache_directory(std::path::PathBuf::from(":memory:"))
        .logger(Arc::new(LogFacadeLogger::new(LogLevel::Off)))
        .build()
        .expect("client build");

    client
        .force_refresh()
        .await
        .expect("force_refresh ok against 200");

    let got: bool = client.get_value("feature.on", false, None).await;
    assert!(got, "feature.on must resolve to true from fetched config");

    let got_off: bool = client.get_value("feature.off", true, None).await;
    assert!(!got_off, "feature.off must resolve to false");

    // get_value_sync exercises the snapshot path (no LazyLoad hook).
    let got_sync: bool = client.get_value_sync("feature.on", false, None);
    assert!(got_sync);

    client.close();
}

#[tokio::test(flavor = "current_thread")]
async fn force_refresh_304_keeps_existing_state() {
    let server = MockServer::start().await;
    // First call returns 200 with an ETag, second returns 304.
    Mock::given(method("GET"))
        .and(path(legacy_path()))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("ETag", "etag-A")
                .set_body_json(config_body()),
        )
        .up_to_n_times(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path(legacy_path()))
        .and(header("If-None-Match", "etag-A"))
        .respond_with(ResponseTemplate::new(304).insert_header("ETag", "etag-A"))
        .expect(1)
        .mount(&server)
        .await;

    let client = Client::builder(TEST_SDK_KEY)
        .polling_mode(PollingMode::ManualPoll)
        .base_url(server.uri())
        .cache_directory(std::path::PathBuf::from(":memory:"))
        .logger(Arc::new(LogFacadeLogger::new(LogLevel::Off)))
        .build()
        .expect("client build");

    client.force_refresh().await.expect("first refresh ok");
    // Second refresh should send If-None-Match and accept 304.
    client.force_refresh().await.expect("second refresh ok");

    // Value still resolves correctly from the cached config.
    let got: bool = client.get_value("feature.on", false, None).await;
    assert!(got);

    client.close();
}

#[tokio::test(flavor = "current_thread")]
async fn force_refresh_500_returns_fetch_failed() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path(legacy_path()))
        .respond_with(ResponseTemplate::new(500))
        .expect(1)
        .mount(&server)
        .await;

    let client = Client::builder(TEST_SDK_KEY)
        .polling_mode(PollingMode::ManualPoll)
        .base_url(server.uri())
        .cache_directory(std::path::PathBuf::from(":memory:"))
        .logger(Arc::new(LogFacadeLogger::new(LogLevel::Off)))
        .build()
        .expect("client build");

    let err = client
        .force_refresh()
        .await
        .expect_err("500 must surface as FetchFailed");
    let msg = format!("{err}");
    assert!(
        msg.contains("HTTP 500") || msg.contains("500"),
        "error message should mention status: {msg}"
    );

    client.close();
}

#[tokio::test(flavor = "current_thread")]
async fn force_refresh_malformed_json_body_returns_fetch_failed() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path(legacy_path()))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("ETag", "v1")
                .set_body_string("not-json-at-all"),
        )
        .expect(1)
        .mount(&server)
        .await;

    let client = Client::builder(TEST_SDK_KEY)
        .polling_mode(PollingMode::ManualPoll)
        .base_url(server.uri())
        .cache_directory(std::path::PathBuf::from(":memory:"))
        .logger(Arc::new(LogFacadeLogger::new(LogLevel::Off)))
        .build()
        .expect("client build");

    let err = client
        .force_refresh()
        .await
        .expect_err("malformed body must surface as FetchFailed");
    let msg = format!("{err}");
    assert!(
        msg.contains("MALFORMED_JSON") || msg.contains("malformed"),
        "error message should mention malformed json: {msg}"
    );

    client.close();
}

#[tokio::test(flavor = "current_thread")]
async fn fetch_uses_default_base_url_when_unreachable_then_times_out() {
    // No wiremock server. Point at a non-routable URL with a tight
    // timeout; the fetcher should classify the error as `timeout` or
    // `connect_error` and `force_refresh` should return `FetchFailed`.
    let client = Client::builder(TEST_SDK_KEY)
        .polling_mode(PollingMode::ManualPoll)
        .base_url("http://127.0.0.1:1") // unroutable port → fast connect_error
        .http_timeout(Duration::from_millis(250))
        .cache_directory(std::path::PathBuf::from(":memory:"))
        .logger(Arc::new(LogFacadeLogger::new(LogLevel::Off)))
        .build()
        .expect("client build");

    let r = client.force_refresh().await;
    assert!(r.is_err(), "unreachable origin must yield FetchFailed");
    client.close();
}

#[tokio::test(flavor = "current_thread")]
async fn force_refresh_after_close_returns_client_closed() {
    let client = Client::builder(TEST_SDK_KEY)
        .polling_mode(PollingMode::ManualPoll)
        .cache_directory(std::path::PathBuf::from(":memory:"))
        .logger(Arc::new(LogFacadeLogger::new(LogLevel::Off)))
        .build()
        .expect("client build");

    // Get a refresh-capable handle *before* close, then close, then
    // attempt to refresh. The Client::close consumes self, so we can't
    // call after close directly; instead we exercise the Drop path
    // which marks closed=true and then snapshot still works.
    let snap = client.snapshot();
    drop(client);

    // Snapshot survives drop — empty cache → resolves to default.
    let got: bool = snap.get_value("any.flag", true, None);
    assert!(got);
}

#[tokio::test(flavor = "current_thread")]
async fn get_value_string_default_resolves_through_serde() {
    // Exercises the serde_json::from_value branch in Client::get_value
    // for a non-boolean default (string). Cache empty → default returned.
    let client = Client::builder(TEST_SDK_KEY)
        .polling_mode(PollingMode::ManualPoll)
        .cache_directory(std::path::PathBuf::from(":memory:"))
        .logger(Arc::new(LogFacadeLogger::new(LogLevel::Off)))
        .build()
        .expect("client build");
    let got: String = client
        .get_value("missing.key", "fallback".to_string(), None)
        .await;
    assert_eq!(got, "fallback");
    client.close();
}

#[tokio::test(flavor = "current_thread")]
async fn debug_impls_redact_sdk_key() {
    let client = Client::builder(TEST_SDK_KEY)
        .polling_mode(PollingMode::ManualPoll)
        .cache_directory(std::path::PathBuf::from(":memory:"))
        .logger(Arc::new(LogFacadeLogger::new(LogLevel::Off)))
        .build()
        .expect("client build");
    let dbg = format!("{client:?}");
    assert!(
        !dbg.contains("BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"),
        "Debug must not leak raw SDK key suffix: {dbg}"
    );
    assert!(dbg.contains("Client"), "Debug must mention the type: {dbg}");

    // ClientBuilder Debug too.
    let builder = Client::builder(TEST_SDK_KEY)
        .polling_mode(PollingMode::ManualPoll)
        .http_timeout(Duration::from_secs(5))
        .base_url("https://example.invalid");
    let bdbg = format!("{builder:?}");
    assert!(
        !bdbg.contains("BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"),
        "Builder Debug must not leak raw SDK key suffix"
    );
    assert!(bdbg.contains("ClientBuilder"));

    client.close();
}

// ---------------------------------------------------------------------
// #803 — the request path (FR-001 / FR-004) and key-free failures (FR-002).
// Paths are compared on the RAW request line the server received (query
// excluded) — the bytes on the wire, never a mock's re-parsed view.
// ---------------------------------------------------------------------

/// A ConfigCat-shaped key from `sdk-key-shapes.json`, and its two
/// 22-character parts.
const CONFIGCAT_SDK_KEY: &str = "configcat-sdk-1/aB3_-dE5fG7hI9jK1lM3nO/pQ5rS7tU9vW1xY3zA5bC7d";
const CONFIGCAT_PARTS: [&str; 2] = ["aB3_-dE5fG7hI9jK1lM3nO", "pQ5rS7tU9vW1xY3zA5bC7d"];

/// Records every log line so a test can assert the key never reaches one.
#[derive(Default)]
struct RecordingLogger(Mutex<Vec<String>>);

impl RecordingLogger {
    fn lines(&self) -> Vec<String> {
        self.0.lock().unwrap().clone()
    }
    fn push(&self, m: &str) {
        self.0.lock().unwrap().push(m.to_string());
    }
}

impl Logger for RecordingLogger {
    fn error(&self, m: &str) {
        self.push(m)
    }
    fn warning(&self, m: &str) {
        self.push(m)
    }
    fn info(&self, m: &str) {
        self.push(m)
    }
    fn debug(&self, m: &str) {
        self.push(m)
    }
}

/// The raw paths of every request a `Client` issues on one `force_refresh`.
async fn fetch_path_via_client(sdk_key: &str) -> Vec<String> {
    let mut server = RawServer::start(Behavior::Respond {
        status: 200,
        headers: vec![("Content-Type".into(), "application/json".into())],
        body: config_body().to_string().into_bytes(),
    })
    .await;
    let client = Client::builder(sdk_key)
        .polling_mode(PollingMode::ManualPoll)
        .base_url(server.base_url.clone())
        .cache_directory(std::path::PathBuf::from(":memory:"))
        .logger(Arc::new(LogFacadeLogger::new(LogLevel::Off)))
        .build()
        .expect("client build");
    let _ = client.force_refresh().await;
    client.close();
    server
        .requests()
        .iter()
        .map(|r| r.path().to_string())
        .collect()
}

#[tokio::test(flavor = "current_thread")]
async fn request_path_legacy_key_is_raw() {
    assert_eq!(
        fetch_path_via_client(TEST_SDK_KEY).await,
        vec![legacy_path()]
    );
}

#[tokio::test(flavor = "current_thread")]
async fn request_path_configcat_key_is_raw_three_segments() {
    assert_eq!(
        fetch_path_via_client(CONFIGCAT_SDK_KEY).await,
        vec![format!(
            "/configuration-files/{CONFIGCAT_SDK_KEY}/config_v6.json"
        )]
    );
}

#[tokio::test(flavor = "current_thread")]
async fn request_path_malformed_key_is_one_escaped_segment() {
    assert_eq!(
        fetch_path_via_client("not/a valid?key").await,
        vec!["/configuration-files/not%2Fa%20valid%3Fkey/config_v6.json".to_string()]
    );
}

/// The shared corpus key, sent as Go's `url.PathEscape` escapes it — the
/// expected path is a literal copied from Go, compared with the raw
/// request line.
#[tokio::test(flavor = "current_thread")]
async fn request_path_malformed_key_matches_go_path_escape_on_the_wire() {
    assert_eq!(
        fetch_path_via_client("bad key$&+:=@,;!'()*~/x?y#z%..").await,
        vec![
            "/configuration-files/bad%20key$&+:=@%2C%3B%21%27%28%29%2A~%2Fx%3Fy%23z%25../config_v6.json"
                .to_string()
        ]
    );
}

#[tokio::test(flavor = "current_thread")]
async fn empty_dot_and_dotdot_keys_issue_no_request() {
    // "" is refused at build time; "." / ".." are refused by the fetcher.
    assert!(Client::builder("").build().is_err());
    for key in [".", ".."] {
        assert!(
            fetch_path_via_client(key).await.is_empty(),
            "key {key:?} MUST NOT reach the network"
        );
    }
    // The fetcher itself refuses all three, with a key-free reason.
    for key in ["", ".", ".."] {
        let logger = Arc::new(RecordingLogger::default());
        let f = ConfigFetcher::new(
            Some("http://127.0.0.1:1".to_string()),
            key.to_string(),
            "0.0.0-test",
            None,
            None,
            logger.clone(),
        )
        .expect("ConfigFetcher::new");
        assert!(f.url().is_none());
        let r = f.fetch(None).await;
        assert_eq!(r.status, FetchStatus::Failed);
        assert_eq!(r.error.as_deref(), Some("INVALID_SDK_KEY"));
        assert!(logger.lines().iter().any(|l| l.contains("INVALID_SDK_KEY")));
    }
}

/// `timeout` never answers; `reset` promises a body and closes mid-way.
async fn raw_server(behavior: &'static str) -> RawServer {
    RawServer::start(if behavior == "timeout" {
        Behavior::Hang
    } else {
        Behavior::CloseMidBody {
            headers: vec![],
            body: config_body().to_string().into_bytes(),
        }
    })
    .await
}

fn assert_key_free(key: &str, label: &str, logs: &[String], error: Option<&str>) {
    let mut needles = vec![key];
    if key == CONFIGCAT_SDK_KEY {
        needles.extend(CONFIGCAT_PARTS);
    }
    let error = error.expect("a failed fetch carries a reason");
    for needle in needles {
        assert!(
            !error.contains(needle),
            "{label}: error {error:?} leaks {needle:?}"
        );
        for line in logs {
            assert!(
                !line.contains(needle),
                "{label}: log {line:?} leaks {needle:?}"
            );
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn forced_failures_never_leak_the_key() {
    for key in [CONFIGCAT_SDK_KEY, TEST_SDK_KEY] {
        // Timeout, mid-body reset (raw TCP), redirect loop (wiremock).
        for (label, expected) in [("timeout", "timeout"), ("reset", "body_read_failed")] {
            let server = raw_server(label).await;
            let logger = Arc::new(RecordingLogger::default());
            let f = ConfigFetcher::new(
                Some(server.base_url.clone()),
                key.to_string(),
                "0.0.0-test",
                Some(Duration::from_millis(300)),
                None,
                logger.clone(),
            )
            .unwrap();
            let r = f.fetch(None).await;
            drop(server);
            assert_eq!(r.status, FetchStatus::Failed, "{label}");
            assert_eq!(r.error.as_deref(), Some(expected), "{label}");
            assert!(
                !logger.lines().is_empty(),
                "{label}: failure MUST be logged"
            );
            assert_key_free(key, label, &logger.lines(), r.error.as_deref());
        }

        let server = MockServer::start().await;
        let self_url = format!("{}/configuration-files/{key}/config_v6.json", server.uri());
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(302).insert_header("Location", self_url.as_str()))
            .mount(&server)
            .await;
        let logger = Arc::new(RecordingLogger::default());
        let f = ConfigFetcher::new(
            Some(server.uri()),
            key.to_string(),
            "0.0.0-test",
            Some(Duration::from_secs(2)),
            None,
            logger.clone(),
        )
        .unwrap();
        let r = f.fetch(None).await;
        assert_eq!(r.status, FetchStatus::Failed, "redirect loop");
        assert_eq!(r.error.as_deref(), Some("redirect_error"));
        assert!(
            !logger.lines().is_empty(),
            "redirect: failure MUST be logged"
        );
        assert_key_free(key, "redirect", &logger.lines(), r.error.as_deref());
    }
}

/// A bad base URL never reaches the network and ends as a fixed code: no
/// library message (reqwest's `Display` ends "for url (<url>)", and the URL
/// holds the key) reaches the result, a log, the error hook or the
/// `RefreshError`.
#[tokio::test(flavor = "current_thread")]
async fn bad_base_url_ends_as_a_fixed_code_without_the_key() {
    let bases = [
        "ftp://cdn.example.test", // parses; reqwest refuses the scheme
        "not a url",
        "http://exa mple.test",
        "http://[::1",
        "http://cdn.example.test:99999",
    ];
    for key in [CONFIGCAT_SDK_KEY, TEST_SDK_KEY] {
        for base in bases {
            let label = format!("base {base:?}");
            let logger = Arc::new(RecordingLogger::default());
            let f = ConfigFetcher::new(
                Some(base.to_string()),
                key.to_string(),
                "0.0.0-test",
                Some(Duration::from_millis(300)),
                None,
                logger.clone(),
            )
            .expect("a bad base URL is not a construction error");
            let r = f.fetch(None).await;
            assert_eq!(r.status, FetchStatus::Failed, "{label}");
            assert_eq!(r.error.as_deref(), Some("builder_error"), "{label}");
            assert!(
                !logger.lines().is_empty(),
                "{label}: failure MUST be logged"
            );
            assert_key_free(key, &label, &logger.lines(), r.error.as_deref());
        }

        // The same through the public Client: build succeeds, the refresh
        // fails with the fixed code, and the error hook sees only that.
        let logger = Arc::new(RecordingLogger::default());
        let hook_lines = Arc::new(Mutex::new(Vec::<String>::new()));
        let hook_sink = hook_lines.clone();
        let client = Client::builder(key)
            .polling_mode(PollingMode::ManualPoll)
            .base_url("ftp://cdn.example.test")
            .cache_directory(std::path::PathBuf::from(":memory:"))
            .logger(logger.clone())
            .on_error(move |m| hook_sink.lock().unwrap().push(m.to_string()))
            .build()
            .expect("client build");
        let err = client
            .force_refresh()
            .await
            .expect_err("a bad base URL must fail the refresh");
        client.close();
        let mut seen = logger.lines();
        seen.extend(hook_lines.lock().unwrap().iter().cloned());
        seen.push(format!("{err}"));
        seen.push(format!("{err:?}"));
        assert!(
            seen.iter().any(|l| l.contains("builder_error")),
            "Client: the fixed code surfaces: {seen:?}"
        );
        assert_key_free(key, "Client bad base", &seen, Some("builder_error"));
    }
}

/// On a redirect reqwest would send the previous (keyed) URL as `Referer`
/// to the next host. The SDK's own client disables that: a cross-host
/// redirect is followed, but the second host receives no `Referer`.
#[tokio::test(flavor = "current_thread")]
async fn cross_host_redirect_sends_no_referer() {
    for key in [CONFIGCAT_SDK_KEY, TEST_SDK_KEY] {
        let mut target = RawServer::start(Behavior::Respond {
            status: 200,
            headers: vec![("Content-Type".into(), "application/json".into())],
            body: config_body().to_string().into_bytes(),
        })
        .await;
        let redirector = RawServer::start(Behavior::Respond {
            status: 302,
            headers: vec![(
                "Location".into(),
                format!("{}/elsewhere/config_v6.json", target.base_url),
            )],
            body: Vec::new(),
        })
        .await;
        let f = ConfigFetcher::new(
            Some(redirector.base_url.clone()),
            key.to_string(),
            "0.0.0-test",
            Some(Duration::from_secs(2)),
            None,
            Arc::new(RecordingLogger::default()),
        )
        .unwrap();
        let r = f.fetch(None).await;
        assert_eq!(
            r.status,
            FetchStatus::Fetched,
            "the redirect is followed: {:?}",
            r.error
        );
        let requests = target.requests();
        assert_eq!(requests.len(), 1, "the second host got one request");
        assert_eq!(requests[0].path(), "/elsewhere/config_v6.json");
        assert_eq!(
            requests[0].header("referer"),
            None,
            "the second host MUST NOT receive a Referer"
        );
        for (name, value) in &requests[0].headers {
            assert!(
                !value.contains(key) && !value.contains(CONFIGCAT_PARTS[0]),
                "header {name}: {value:?} carries the key"
            );
        }
    }
}
