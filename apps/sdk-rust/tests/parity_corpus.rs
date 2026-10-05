// SPDX-License-Identifier: MIT

//! Spec 041 US1 parity gate — 58/58 byte-identical to ConfigCat.
//!
//! Loads the TS-generated parity corpus and the canonical configs from
//! `packages/test-fixtures-sdk-parity/fixtures/`, builds one
//! `confeature::Client` per tuple in `ManualPoll` mode with a
//! `LocalOnly` override bundle holding the tuple's config-specific map,
//! and asserts that the resolved value equals the recorded `expected`
//! byte-for-byte.
//!
//! Constitution invariant (Principle II NON-NEGOTIABLE): 58/58 MUST
//! pass. If a tuple drifts, STOP and investigate the override-eval /
//! evaluator code — never mutate the corpus to make the test green.
//!
//! Implementation note: every tuple is a separate sub-assertion (no
//! `#[test]`-per-tuple, but the failure message includes
//! `tuple.description` so a drift surfaces immediately). The Go parallel
//! uses `t.Run`; Rust's integration-test runner doesn't surface
//! dynamically-named tests with comparable ergonomics, so we keep a
//! single `#[tokio::test]` driver.

mod common;

use confeature::{
    Client, FlagOverrides, MapOverrideDataSource, OverrideBehaviour, PollingMode, User,
};
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;

const PARITY_SDK_KEY: &str =
    "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

#[derive(Debug, Deserialize)]
struct ParityTuple {
    description: String,
    #[serde(rename = "configId")]
    config_id: String,
    key: String,
    #[serde(rename = "defaultValue")]
    default_value: Value,
    user: Option<CorpusUser>,
    expected: Value,
}

#[derive(Debug, Deserialize, Clone)]
struct CorpusUser {
    #[serde(default)]
    identifier: Option<String>,
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    country: Option<String>,
    #[serde(default)]
    custom: Option<HashMap<String, String>>,
}

impl CorpusUser {
    fn to_user(&self) -> User {
        let mut u = User::new(self.identifier.clone().unwrap_or_default());
        if let Some(email) = &self.email {
            u = u.with_email(email);
        }
        if let Some(country) = &self.country {
            u = u.with_country(country);
        }
        if let Some(custom) = &self.custom {
            for (k, v) in custom {
                u = u.with_custom(k, v);
            }
        }
        u
    }
}

#[derive(Debug, Deserialize)]
struct ParityConfigRecord {
    id: String,
    #[serde(rename = "overridesMap")]
    overrides_map: HashMap<String, Value>,
}

fn load_corpus() -> Vec<ParityTuple> {
    let path = common::parity_corpus_path();
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("read parity corpus {}: {e}", path.display()));
    serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parse parity-corpus.json: {e}"))
}

fn load_configs() -> HashMap<String, ParityConfigRecord> {
    let path = common::parity_configs_path();
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("read parity configs {}: {e}", path.display()));
    let records: Vec<ParityConfigRecord> =
        serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parse parity-configs.json: {e}"));
    records.into_iter().map(|r| (r.id.clone(), r)).collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn parity_corpus_byte_identical() {
    let tuples = load_corpus();
    let configs = load_configs();

    assert_eq!(
        tuples.len(),
        58,
        "expected 58 corpus tuples, got {} — \
         regenerate via `pnpm run export:corpus` in \
         packages/test-fixtures-sdk-parity/",
        tuples.len()
    );

    let mut failures: Vec<String> = Vec::new();

    for tuple in &tuples {
        let cfg = configs.get(&tuple.config_id).unwrap_or_else(|| {
            panic!(
                "corpus references unknown configId={:?}; \
                 regenerate fixtures via `pnpm run export:corpus`",
                tuple.config_id
            )
        });

        let overrides = FlagOverrides::new(
            Box::new(MapOverrideDataSource::new(cfg.overrides_map.clone())),
            OverrideBehaviour::LocalOnly,
        );
        let client = Client::builder(PARITY_SDK_KEY)
            .polling_mode(PollingMode::ManualPoll)
            .flag_overrides(overrides)
            .cache_directory(std::path::PathBuf::from(":memory:"))
            .build()
            .expect("client build");

        let user_owned = tuple.user.as_ref().map(CorpusUser::to_user);
        let actual: Value = client
            .get_value::<Value>(&tuple.key, tuple.default_value.clone(), user_owned.as_ref())
            .await;

        if actual != tuple.expected {
            failures.push(format!(
                "Parity drift on {:?}\n  expected: {} ({})\n  actual:   {} ({})",
                tuple.description,
                tuple.expected,
                value_kind(&tuple.expected),
                actual,
                value_kind(&actual),
            ));
        }

        client.close();
    }

    if !failures.is_empty() {
        panic!(
            "{}/{} parity tuples drifted — Constitution Principle II \
             NON-NEGOTIABLE; investigate the evaluator / override-eval \
             code, do NOT mutate the corpus.\n\n{}",
            failures.len(),
            tuples.len(),
            failures.join("\n\n"),
        );
    }
}

fn value_kind(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "bool",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

// ── #258 typed-corpus tier ───────────────────────────────────────────
//
// Sibling driver to `parity_corpus_byte_identical`. Loads the 13-tuple
// typed corpus + the typed-configs file and exercises the four-type
// evaluator (string / int / double) across the typed `SettingType`
// matrix plus 3 TYPE_MISMATCH cases. The boolean tier above is left
// byte-unchanged (US4 / FR-009).

fn load_typed_corpus() -> Vec<ParityTuple> {
    let path = common::parity_corpus_typed_path();
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("read typed parity corpus {}: {e}", path.display()));
    serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parse parity-corpus-typed.json: {e}"))
}

fn load_typed_configs() -> HashMap<String, ParityConfigRecord> {
    let path = common::parity_configs_typed_path();
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("read typed parity configs {}: {e}", path.display()));
    let records: Vec<ParityConfigRecord> = serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("parse parity-configs-typed.json: {e}"));
    records.into_iter().map(|r| (r.id.clone(), r)).collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn parity_corpus_typed_byte_identical() {
    let tuples = load_typed_corpus();
    let configs = load_typed_configs();

    assert_eq!(
        tuples.len(),
        13,
        "expected 13 typed corpus tuples, got {} — \
         regenerate via `pnpm run export:corpus` in \
         packages/test-fixtures-sdk-parity/",
        tuples.len()
    );

    let mut failures: Vec<String> = Vec::new();

    for tuple in &tuples {
        let cfg = configs.get(&tuple.config_id).unwrap_or_else(|| {
            panic!(
                "typed corpus references unknown configId={:?}; \
                 regenerate fixtures via `pnpm run export:corpus`",
                tuple.config_id
            )
        });

        let overrides = FlagOverrides::new(
            Box::new(MapOverrideDataSource::new(cfg.overrides_map.clone())),
            OverrideBehaviour::LocalOnly,
        );
        let client = Client::builder(PARITY_SDK_KEY)
            .polling_mode(PollingMode::ManualPoll)
            .flag_overrides(overrides)
            .cache_directory(std::path::PathBuf::from(":memory:"))
            .build()
            .expect("client build");

        let user_owned = tuple.user.as_ref().map(CorpusUser::to_user);
        let actual: Value = client
            .get_value::<Value>(&tuple.key, tuple.default_value.clone(), user_owned.as_ref())
            .await;

        if actual != tuple.expected {
            failures.push(format!(
                "Typed parity drift on {:?}\n  expected: {} ({})\n  actual:   {} ({})",
                tuple.description,
                tuple.expected,
                value_kind(&tuple.expected),
                actual,
                value_kind(&actual),
            ));
        }

        client.close();
    }

    if !failures.is_empty() {
        panic!(
            "{}/{} typed parity tuples drifted — Constitution Principle II \
             NON-NEGOTIABLE; investigate the evaluator code, do NOT mutate \
             the corpus.\n\n{}",
            failures.len(),
            tuples.len(),
            failures.join("\n\n"),
        );
    }
}
