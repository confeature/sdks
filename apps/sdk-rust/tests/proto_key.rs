// SPDX-License-Identifier: MIT

//! #826 — ConfigCat reserves no setting key, so the api serves `__proto__` as
//! an ordinary key of config_v6 `f`. A JS SDK once dropped it by copying
//! settings into a plain object; these tests hold the Rust SDK to keeping it
//! from the served bytes and from a local override.

use confeature::{
    Client, FlagOverrides, LogFacadeLogger, LogLevel, MapOverrideDataSource, OverrideBehaviour,
    PollingMode,
};
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;
use wiremock::matchers::method;
use wiremock::{Mock, MockServer, ResponseTemplate};

const TEST_SDK_KEY: &str =
    "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const SERVED: &str = r#"{"p":{"u":"","r":0,"s":"salt"},"f":{"__proto__":{"t":0,"v":{"b":true},"i":"v-proto","r":[]}},"s":[]}"#;

#[tokio::test(flavor = "current_thread")]
async fn a_served_proto_flag_returns_its_served_value() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200).set_body_string(SERVED))
        .mount(&server)
        .await;
    let client = Client::builder(TEST_SDK_KEY)
        .polling_mode(PollingMode::ManualPoll)
        .base_url(server.uri())
        .cache_directory(std::path::PathBuf::from(":memory:"))
        .logger(Arc::new(LogFacadeLogger::new(LogLevel::Off)))
        .build()
        .expect("client build");
    client.force_refresh().await.expect("force_refresh ok");
    let got: bool = client.get_value("__proto__", false, None).await;
    assert!(
        got,
        "__proto__ must resolve to its served value, not the default"
    );
    client.close();
}

#[tokio::test(flavor = "current_thread")]
async fn a_local_only_override_keyed_proto_returns_the_override() {
    let mut map = HashMap::new();
    map.insert("__proto__".to_string(), json!(true));
    let client = Client::builder(TEST_SDK_KEY)
        .polling_mode(PollingMode::ManualPoll)
        .flag_overrides(FlagOverrides::new(
            Box::new(MapOverrideDataSource::new(map)),
            OverrideBehaviour::LocalOnly,
        ))
        .logger(Arc::new(LogFacadeLogger::new(LogLevel::Off)))
        .build()
        .expect("client build");
    let got: bool = client.get_value("__proto__", false, None).await;
    assert!(got, "the __proto__ override must win under LocalOnly");
    client.close();
}
