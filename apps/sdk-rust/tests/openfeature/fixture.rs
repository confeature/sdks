// SPDX-License-Identifier: MIT

use confeature::{Client, ClientBuilder, PollingMode};
use reqwest::{redirect::Policy, Client as HttpClient, Proxy, Url};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const TARGETED: &str = "stringIsInDogDefaultCat";

pub struct Fixture {
    pub key: String,
    origin: String,
    proxy: String,
    canary: String,
    cancellation: PathBuf,
    admin: HttpClient,
}

impl Fixture {
    pub fn new() -> Self {
        let key = std::env::var("OPENFEATURE_RUST_FIXTURE_KEY").unwrap();
        assert_eq!(
            key,
            "configcat-sdk-1/AAAAAAAAAAAAAAAAAAAAAA/BBBBBBBBBBBBBBBBBBBBBB"
        );
        Self {
            key,
            origin: bound_origin("LIVE_HARNESS_URL"),
            proxy: bound_origin("OPENFEATURE_RUST_PROXY"),
            canary: bound_origin("OPENFEATURE_RUST_CANARY"),
            cancellation: std::env::var_os("OPENFEATURE_RUST_CANCEL_ACK")
                .expect("a cancellation receipt path is required")
                .into(),
            admin: http_builder().build().unwrap(),
        }
    }

    pub fn client(&self, mode: PollingMode, cache: &Path) -> ClientBuilder {
        Client::builder(&self.key)
            .polling_mode(mode)
            .cache_directory(cache)
            .base_url(&self.origin)
            .http_client(self.guarded_http())
    }

    pub fn delaying_client(&self, cache: &Path) -> ClientBuilder {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            "x-confeature-fixture-delay",
            reqwest::header::HeaderValue::from_static("1"),
        );
        self.client(PollingMode::lazy_load_default(), cache)
            .http_client(
                self.proxy_builder()
                    .default_headers(headers)
                    .build()
                    .unwrap(),
            )
    }

    pub async fn served(&self) -> usize {
        self.admin
            .get(format!("{}/admin/requests", self.origin))
            .query(&[("sdkKey", &self.key)])
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json::<Value>()
            .await
            .unwrap()["requests"]
            .as_array()
            .unwrap()
            .len()
    }

    pub async fn wait_for_requests(&self, wanted: usize) {
        tokio::time::timeout(Duration::from_secs(4), async {
            while self.served().await < wanted {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the seeded request did not reach the fixture");
    }

    pub async fn wait_for_cancellation(&self) {
        tokio::time::timeout(Duration::from_secs(2), async {
            while !std::fs::read(&self.cancellation)
                .is_ok_and(|receipt| receipt.as_slice() == b"closed\n")
            {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("dropping the evaluation must close the delayed socket before the response");
    }

    pub async fn fault(&self, mode: &str) {
        self.admin
            .post(format!("{}/admin/inject-fault", self.origin))
            .json(&json!({ "sdkKey": &self.key, "fault": mode }))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap();
    }

    pub async fn check_transport(&self) {
        let before = self.served().await;
        let http = self.guarded_http();
        let path = format!("/configuration-files/{}/config_v6.json", self.key);
        let wrong_origin = http
            .get(format!("{}{}", self.canary, path))
            .send()
            .await
            .unwrap();
        assert_eq!(wrong_origin.status(), 403);
        let redirect = http
            .get(format!("{}{}", self.origin, path))
            .header("x-confeature-fixture-redirect", "1")
            .send()
            .await
            .unwrap();
        assert_eq!(redirect.status(), 302);

        let cache = tempfile::tempdir().unwrap();
        let default_origin = Client::builder(&self.key)
            .polling_mode(PollingMode::ManualPoll)
            .cache_directory(cache.path())
            .http_client(http)
            .build()
            .unwrap();
        assert!(default_origin.force_refresh().await.is_err());
        default_origin.close();
        assert_eq!(self.served().await, before);
    }

    fn guarded_http(&self) -> HttpClient {
        self.proxy_builder().build().unwrap()
    }

    fn proxy_builder(&self) -> reqwest::ClientBuilder {
        http_builder().proxy(Proxy::all(&self.proxy).unwrap())
    }
}

fn http_builder() -> reqwest::ClientBuilder {
    HttpClient::builder()
        .no_proxy()
        .redirect(Policy::none())
        .referer(false)
        .timeout(Duration::from_secs(6))
}

fn bound_origin(name: &str) -> String {
    let origin = std::env::var(name).expect("a bound fixture origin is required");
    let parsed = Url::parse(&origin).unwrap();
    let port = parsed
        .port()
        .expect("the fixture origin needs a bound port");
    assert_eq!(origin, format!("http://127.0.0.1:{port}"));
    origin
}
