// SPDX-License-Identifier: MIT

//! HTTP wrapper around `reqwest::Client` for the Confeature CDN.
//!
//! Responsibilities:
//! - User-Agent: `confeature-rust-sdk/{VERSION}` (FR-019).
//! - `If-None-Match` support for 304 reuse (FR-018).
//! - Configurable request timeout (default 30 s).
//! - SDK key redaction in EVERY log line + error message (FR-020):
//!   the raw key is NEVER interpolated; [`crate::internal::sdk_key::redact_sdk_key`]
//!   is the only path.
//! - The config URL is built in ONE function, [`config_url`] (#803 FR-001).
//!   The path is ConfigCat's: `<base>/configuration-files/<sdkKey>/config_v6.json`
//!   with a well-shaped key RAW, exactly as the upstream `configcat` crate
//!   builds it (`configcat-0.1.5/src/fetch/fetcher.rs:110-114`,
//!   `"{url}/configuration-files/{sdk_key}/{config_json_name}"`). The key
//!   is therefore IN the URL, so no transport/library error message may ever
//!   reach a log or a [`FetchResult`] — only the fixed codes of
//!   [`classify_reqwest_error`] do (#803 FR-002).

use crate::internal::sdk_key::{is_valid_confeature_key_format, redact_sdk_key};
use crate::logger::Logger;
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;

/// Production CDN base URL.
pub const DEFAULT_BASE_URL: &str = "https://cdn-global.confeature.io";

/// Default per-request timeout.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

/// Outcome status of one fetch call.
///
/// Public so [`crate::__wire_test_api`] can re-export it for the
/// `tests/wire_cases.rs` integration suite (epic #146 / issue #148 /
/// spec 112). The enclosing module is `pub(crate)` so this type does
/// NOT leak into the crate's public API surface despite the `pub`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FetchStatus {
    Fetched,
    NotModified,
    Failed,
}

/// Result envelope returned by [`ConfigFetcher::fetch`]. `body` is set
/// only when `status == Fetched`. `error` carries a short, key-free
/// reason code when `status == Failed`.
///
/// Public for the same reason as [`FetchStatus`] — the enclosing
/// `internal` module is `pub(crate)`, so this is a crate-internal type
/// exposed solely via the `#[doc(hidden)]` test re-export.
#[derive(Debug, Clone)]
pub struct FetchResult {
    pub status: FetchStatus,
    pub body: Option<Value>,
    pub etag: Option<String>,
    pub error: Option<String>,
}

impl FetchResult {
    fn fetched(body: Value, etag: Option<String>) -> Self {
        Self {
            status: FetchStatus::Fetched,
            body: Some(body),
            etag,
            error: None,
        }
    }
    fn not_modified(etag: Option<String>) -> Self {
        Self {
            status: FetchStatus::NotModified,
            body: None,
            etag,
            error: None,
        }
    }
    fn failed(reason: impl Into<String>) -> Self {
        Self {
            status: FetchStatus::Failed,
            body: None,
            etag: None,
            error: Some(reason.into()),
        }
    }
}

/// HTTP fetcher. Owns a `reqwest::Client` configured with the customer's
/// timeout + TLS settings.
///
/// Public for the same reason as [`FetchResult`] — exposed via the
/// `#[doc(hidden)] crate::__wire_test_api` re-export so the
/// `tests/wire_cases.rs` integration suite can drive the wire layer
/// directly without going through `Client`'s poll-service indirection.
pub struct ConfigFetcher {
    http_client: reqwest::Client,
    sdk_key: String,
    base_url: String,
    user_agent: String,
    logger: Arc<dyn Logger>,
}

impl ConfigFetcher {
    /// Constructs a [`ConfigFetcher`].
    ///
    /// - `base_url` empty → [`DEFAULT_BASE_URL`].
    /// - `timeout` zero  → [`DEFAULT_TIMEOUT`].
    /// - `http_client` `None` → fresh `reqwest::Client::builder()` with
    ///   the supplied timeout and `Referer` disabled, so a redirect never
    ///   forwards the keyed URL to the next host. An injected client keeps
    ///   its own settings.
    pub fn new(
        base_url: Option<String>,
        sdk_key: String,
        version: &str,
        timeout: Option<Duration>,
        http_client: Option<reqwest::Client>,
        logger: Arc<dyn Logger>,
    ) -> Result<Self, String> {
        let base = base_url
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| DEFAULT_BASE_URL.to_string());
        let base = base.trim_end_matches('/').to_string();
        let timeout = timeout.filter(|d| !d.is_zero()).unwrap_or(DEFAULT_TIMEOUT);
        let client = match http_client {
            Some(c) => c,
            // `referer(false)`: on a redirect reqwest otherwise sends the
            // previous URL — which carries the SDK key — as `Referer` to
            // the next host, even a foreign one (#803).
            None => reqwest::Client::builder()
                .timeout(timeout)
                .referer(false)
                .build()
                // Fixed text: a library message never leaves the SDK (FR-002).
                .map_err(|_| "build http client: builder_error".to_string())?,
        };
        let user_agent = format!("confeature-rust-sdk/{version}");
        Ok(Self {
            http_client: client,
            sdk_key,
            base_url: base,
            user_agent,
            logger,
        })
    }

    /// Full CDN URL the fetcher targets — see [`config_url`]. `None` when
    /// the SDK refuses to fetch for this key (empty, `.` or `..`).
    pub fn url(&self) -> Option<String> {
        config_url(&self.base_url, &self.sdk_key)
    }

    /// Issues a single GET. Never panics; failures land in
    /// `FetchResult { status: Failed, error: Some(...) }` with the
    /// SDK key redacted in any log line.
    pub async fn fetch(&self, prev_etag: Option<&str>) -> FetchResult {
        let Some(url) = self.url() else {
            self.logger.error(&format!(
                "ConfigFetcher: refusing to fetch — INVALID_SDK_KEY (sdkKey={})",
                redact_sdk_key(&self.sdk_key)
            ));
            return FetchResult::failed("INVALID_SDK_KEY");
        };
        let mut req = self
            .http_client
            .get(url)
            .header("User-Agent", &self.user_agent);
        req = req.header("Accept", "application/json");
        if let Some(etag) = prev_etag {
            if !etag.is_empty() {
                req = req.header("If-None-Match", etag);
            }
        }

        let resp = match req.send().await {
            Ok(r) => r,
            Err(err) => {
                let reason = classify_reqwest_error(&err);
                self.logger.error(&format!(
                    "ConfigFetcher: fetch raised (sdkKey={}, reason={})",
                    redact_sdk_key(&self.sdk_key),
                    reason
                ));
                return FetchResult::failed(reason);
            }
        };

        let status = resp.status();
        let etag = resp
            .headers()
            .get("etag")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);

        if status == reqwest::StatusCode::NOT_MODIFIED {
            return FetchResult::not_modified(etag);
        }
        if !status.is_success() {
            let reason = format!("HTTP {}", status.as_u16());
            self.logger.error(&format!(
                "ConfigFetcher: fetch failed (sdkKey={}, reason={})",
                redact_sdk_key(&self.sdk_key),
                reason
            ));
            return FetchResult::failed(reason);
        }

        let body_bytes = match resp.bytes().await {
            Ok(b) => b,
            Err(err) => {
                let reason = classify_reqwest_error(&err);
                self.logger.error(&format!(
                    "ConfigFetcher: body read raised (sdkKey={}, reason={})",
                    redact_sdk_key(&self.sdk_key),
                    reason
                ));
                return FetchResult::failed(reason);
            }
        };
        let body: Value = match serde_json::from_slice(&body_bytes) {
            Ok(v) => v,
            Err(_) => {
                self.logger.error(&format!(
                    "ConfigFetcher: fetch returned non-JSON body (sdkKey={}, reason=MALFORMED_JSON)",
                    redact_sdk_key(&self.sdk_key)
                ));
                return FetchResult::failed("MALFORMED_JSON");
            }
        };
        // Shape validation: a valid config_v6.json carries the
        // {p, f, s} top-level shape. sdk-node + sdk-python + sdk-go
        // tighten the same check so the corpus-wide
        // `wire-cases.json::wrong-shape-200` case surfaces the same
        // `parseFailed` everywhere (epic #146 / issue #148). A 200
        // with a body that doesn't match the contract is a stronger
        // signal of CDN drift than a 5xx and deserves its own typed
        // error class. Probing the `f` key alone is sufficient — it
        // is the only mandatory top-level key in the schema.
        if body.get("f").is_none() {
            self.logger.error(&format!(
                "ConfigFetcher: fetch returned JSON without 'f' key (sdkKey={})",
                redact_sdk_key(&self.sdk_key)
            ));
            return FetchResult::failed("MALFORMED_JSON");
        }
        FetchResult::fetched(body, etag)
    }
}

/// Builds the config URL — the ONE place the SDK forms it (#803 FR-001).
///
/// - A key matching the shared key shape (`sdk-key-shapes.json`, see
///   [`is_valid_confeature_key_format`]) goes in RAW: split on `/`, each
///   part path-segment-escaped (a no-op for a valid key). A
///   `configcat-sdk-1/<22>/<22>` key thus keeps its three segments — the
///   exact bytes the upstream `configcat` crate sends.
/// - Any other key is escaped into ONE segment (Go's `url.PathEscape`).
/// - Empty, `.` and `..` keys yield `None`: no escaper keeps them inside
///   their segment, so the SDK refuses to fetch (`INVALID_SDK_KEY`).
///
/// The local cache id (the derived cache-key tail) never travels on the wire.
pub fn config_url(base_url: &str, sdk_key: &str) -> Option<String> {
    let key_path = if is_valid_confeature_key_format(sdk_key) {
        sdk_key
            .split('/')
            .map(escape_path_segment)
            .collect::<Vec<_>>()
            .join("/")
    } else {
        if sdk_key.is_empty() || sdk_key == "." || sdk_key == ".." {
            return None;
        }
        escape_path_segment(sdk_key)
    };
    Some(format!(
        "{base_url}/configuration-files/{key_path}/config_v6.json"
    ))
}

/// Percent-escapes one path segment, keeping the bytes Go's
/// `url.PathEscape` keeps (`A-Z a-z 0-9 - . _ ~ $ & + = : @`); every
/// other byte — `/`, `%`, `?`, `#`, space, non-ASCII — becomes `%XX`.
fn escape_path_segment(segment: &str) -> String {
    let mut out = String::with_capacity(segment.len());
    for b in segment.bytes() {
        if b.is_ascii_alphanumeric()
            || matches!(
                b,
                b'-' | b'.' | b'_' | b'~' | b'$' | b'&' | b'+' | b'=' | b':' | b'@'
            )
        {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Reduces a `reqwest::Error` to a FIXED, key-free reason code (#803
/// FR-002, Go's `classifyError` pattern). The URL now carries the SDK key
/// and `reqwest`'s `Display` ends with "for url (<url>)", so the library
/// message is NEVER used — not even as a fall-through.
fn classify_reqwest_error(err: &reqwest::Error) -> &'static str {
    if err.is_timeout() {
        "timeout"
    } else if err.is_redirect() {
        "redirect_error"
    } else if err.is_connect() {
        "connect_error"
    } else if err.is_body() || err.is_decode() {
        // reqwest 0.12 reports a truncated `bytes()` read as `decode`.
        "body_read_failed"
    } else if err.is_builder() {
        "builder_error"
    } else if err.is_request() {
        "request_error"
    } else {
        "fetch_failed"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logger::LogFacadeLogger;

    fn fetcher(base: Option<&str>, key: &str) -> ConfigFetcher {
        ConfigFetcher::new(
            base.map(str::to_string),
            key.to_string(),
            "0.1.0",
            None,
            None,
            Arc::new(LogFacadeLogger::default()),
        )
        .expect("ConfigFetcher::new")
    }

    /// The parsed path of the fetcher's URL (query excluded).
    fn path_of(f: &ConfigFetcher) -> String {
        reqwest::Url::parse(&f.url().expect("url"))
            .expect("parse url")
            .path()
            .to_string()
    }

    const LEGACY: &str =
        "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    const CONFIGCAT: &str = "configcat-sdk-1/aB3_-dE5fG7hI9jK1lM3nO/pQ5rS7tU9vW1xY3zA5bC7d";

    #[test]
    fn legacy_key_travels_raw_as_one_segment() {
        let f = fetcher(Some("https://cdn.example"), LEGACY);
        assert!(f.url().unwrap().starts_with("https://cdn.example/"));
        assert_eq!(
            path_of(&f),
            format!("/configuration-files/{LEGACY}/config_v6.json")
        );
    }

    #[test]
    fn configcat_key_travels_raw_as_three_segments() {
        let f = fetcher(Some("https://cdn.example"), CONFIGCAT);
        assert_eq!(
            path_of(&f),
            format!("/configuration-files/{CONFIGCAT}/config_v6.json")
        );
    }

    #[test]
    fn malformed_key_is_one_escaped_segment() {
        let f = fetcher(Some("https://cdn.example"), "bad/key ?#%");
        assert_eq!(
            path_of(&f),
            "/configuration-files/bad%2Fkey%20%3F%23%25/config_v6.json"
        );
        // A non-ASCII key never panics and stays one segment.
        let f = fetcher(Some("https://cdn.example"), "clé/../x");
        assert_eq!(
            path_of(&f),
            "/configuration-files/cl%C3%A9%2F..%2Fx/config_v6.json"
        );
    }

    /// The exact string [`config_url`] builds — compared as text, not
    /// re-parsed — against Go's `url.PathEscape` output, copied literally.
    #[test]
    fn malformed_key_matches_go_path_escape_literally() {
        assert_eq!(
            config_url("https://cdn.example", "bad key$&+:=@,;!'()*~/x?y#z%..").as_deref(),
            Some(
                "https://cdn.example/configuration-files/\
                 bad%20key$&+:=@%2C%3B%21%27%28%29%2A~%2Fx%3Fy%23z%25../config_v6.json"
            )
        );
    }

    #[test]
    fn empty_dot_and_dotdot_keys_have_no_url() {
        for key in ["", ".", ".."] {
            assert!(fetcher(None, key).url().is_none(), "key {key:?}");
        }
    }

    #[test]
    fn default_base_url_used_when_empty() {
        let f = fetcher(None, "k");
        assert!(f
            .url()
            .unwrap()
            .starts_with("https://cdn-global.confeature.io/configuration-files/"));
    }

    #[test]
    fn user_agent_format() {
        let f = ConfigFetcher::new(
            None,
            "k".to_string(),
            "1.2.3",
            None,
            None,
            Arc::new(LogFacadeLogger::default()),
        )
        .expect("ConfigFetcher::new");
        assert_eq!(f.user_agent, "confeature-rust-sdk/1.2.3");
    }
}
