// SPDX-License-Identifier: MIT

use super::*;
use crate::user::UserValue;
use crate::{
    create_flag_overrides_from_config, FlagOverrides, OverrideBehaviour, OverrideDataSource,
    PollingMode, User,
};
use open_feature::EvaluationContextFieldValue;
use serde_json::json;
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};

const SDK_KEY: &str = "configcat-sdk-1/aaaaaaaaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbbbbbbbb";

struct FlatOverrides {
    reads: Arc<AtomicUsize>,
}

impl OverrideDataSource for FlatOverrides {
    fn get_overrides_sync(&self) -> Option<HashMap<String, Value>> {
        self.reads.fetch_add(1, Ordering::Relaxed);
        Some(HashMap::from([
            ("same".into(), json!(false)),
            ("null".into(), Value::Null),
            ("integer".into(), json!(7)),
            ("float".into(), json!(7.0)),
            ("huge-int".into(), json!(u64::MAX)),
        ]))
    }
}

#[tokio::test]
async fn flat_evaluation_reads_once_and_keeps_legacy_fallbacks() {
    let reads = Arc::new(AtomicUsize::new(0));
    let callbacks = Arc::new(AtomicUsize::new(0));
    let seen = callbacks.clone();
    let client = Arc::new(
        Client::builder(SDK_KEY)
            .cache_directory(":memory:")
            .polling_mode(PollingMode::ManualPoll)
            .flag_overrides(FlagOverrides::new(
                Box::new(FlatOverrides {
                    reads: reads.clone(),
                }),
                OverrideBehaviour::LocalOnly,
            ))
            .on_flag_evaluated(move |details| {
                if details.key == "same" {
                    assert!(!details.is_default_value);
                    assert!(details.error.is_none());
                }
                seen.fetch_add(1, Ordering::Relaxed);
            })
            .build()
            .unwrap(),
    );
    let provider = ConfeatureProvider::new(client.clone()).unwrap();
    let context = EvaluationContext::default();

    let same = provider.resolve_bool_value("same", &context).await.unwrap();
    assert!(!same.value);
    assert!(same.variant.is_none());
    assert!(same.reason.is_none());
    assert_eq!(reads.load(Ordering::Relaxed), 1);
    assert_eq!(callbacks.load(Ordering::Relaxed), 1);

    assert_flat_errors(&provider, &context).await;
    assert_eq!(reads.load(Ordering::Relaxed), 7);
    assert_eq!(callbacks.load(Ordering::Relaxed), 7);
    for key in ["missing", "null", "integer"] {
        let legacy = client.get_value_details(key, false, None).await;
        assert!(!legacy.value);
        assert!(legacy.error.is_none());
        assert!(!legacy.is_default_value);
        assert!(!client.get_value(key, false, None).await);
    }
    assert_eq!(
        client.get_value_details("integer", 0.0, None).await.value,
        7.0
    );
}

async fn assert_flat_errors(provider: &ConfeatureProvider, context: &EvaluationContext) {
    use EvaluationErrorCode::{FlagNotFound, General, TypeMismatch};

    for (key, code) in [
        ("missing", FlagNotFound),
        ("null", General("GENERAL".into())),
        ("integer", TypeMismatch),
    ] {
        let error = provider.resolve_bool_value(key, context).await.unwrap_err();
        assert_eq!(error.code, code);
    }
    let integer = provider
        .resolve_int_value("huge-int", context)
        .await
        .unwrap_err();
    assert_eq!(integer.code, TypeMismatch);
    let float = provider
        .resolve_float_value("integer", context)
        .await
        .unwrap_err();
    assert_eq!(float.code, TypeMismatch);
    assert_eq!(
        provider
            .resolve_float_value("float", context)
            .await
            .unwrap()
            .value,
        7.0
    );
}

fn configured_provider() -> ConfeatureProvider {
    let config = json!({
        "f": {
            "color": {
                "t": 1, "v": {"s": "blue"}, "i": "blue-variant",
                "r": [{
                    "c": [{"u": {"a": "Identifier", "c": 28, "s": "target"}}],
                    "s": {"v": {"s": "red"}, "i": "red-variant"}
                }]
            },
            "split": {
                "t": 0, "v": {"b": false}, "i": "base-variant",
                "p": [{"p": 100, "v": {"b": true}, "i": "split-variant"}]
            },
            "int": {"t": 2, "v": {"i": 9}},
            "dou": {"t": 3, "v": {"d": 1}},
            "broken": {"t": 0, "v": {"b": null}},
            "oversized": {"t": 2, "v": {"i": u64::MAX}}
        }
    });
    let client = Client::builder(SDK_KEY)
        .cache_directory(":memory:")
        .flag_overrides(create_flag_overrides_from_config(
            config,
            OverrideBehaviour::LocalOnly,
        ))
        .build()
        .unwrap();
    ConfeatureProvider::new(Arc::new(client)).unwrap()
}

#[tokio::test]
async fn typed_evaluation_preserves_values_variants_and_matching_reasons() {
    let provider = configured_provider();
    assert_eq!(provider.metadata().name, "Confeature");
    let targeted = EvaluationContext::default().with_targeting_key("target");
    let anonymous = EvaluationContext::default().with_custom_field("Identifier", "target");

    let result = provider
        .resolve_string_value("color", &targeted)
        .await
        .unwrap();
    assert_eq!(result.value, "red");
    assert_eq!(result.variant.as_deref(), Some("red-variant"));
    assert_eq!(result.reason, Some(EvaluationReason::TargetingMatch));
    let result = provider
        .resolve_string_value("color", &anonymous)
        .await
        .unwrap();
    assert_eq!(result.value, "blue");
    assert_eq!(result.variant.as_deref(), Some("blue-variant"));
    assert!(result.reason.is_none());

    let result = provider
        .resolve_bool_value("split", &targeted)
        .await
        .unwrap();
    assert!(result.value);
    assert_eq!(result.variant.as_deref(), Some("split-variant"));
    assert_eq!(result.reason, Some(EvaluationReason::Split));
    assert!(
        !provider
            .resolve_bool_value("split", &anonymous)
            .await
            .unwrap()
            .value
    );

    assert_eq!(
        provider
            .resolve_int_value("int", &anonymous)
            .await
            .unwrap()
            .value,
        9
    );
    assert_eq!(
        provider
            .resolve_float_value("dou", &anonymous)
            .await
            .unwrap()
            .value,
        1.0
    );
}

#[tokio::test]
async fn typed_evaluation_rejects_wrong_or_malformed_values() {
    use EvaluationErrorCode::{FlagNotFound, ParseError, TypeMismatch};
    let provider = configured_provider();
    let context = EvaluationContext::default();
    for (key, code) in [
        ("absent", FlagNotFound),
        ("int", TypeMismatch),
        ("broken", ParseError),
    ] {
        assert_eq!(
            provider
                .resolve_bool_value(key, &context)
                .await
                .unwrap_err()
                .code,
            code
        );
    }
    assert_eq!(
        provider
            .resolve_int_value("dou", &context)
            .await
            .unwrap_err()
            .code,
        TypeMismatch
    );
    assert_eq!(
        provider
            .resolve_float_value("int", &context)
            .await
            .unwrap_err()
            .code,
        TypeMismatch
    );
    assert_eq!(
        provider
            .resolve_int_value("oversized", &context)
            .await
            .unwrap_err()
            .code,
        ParseError
    );
    assert_eq!(
        provider
            .resolve_struct_value("color", &context)
            .await
            .unwrap_err()
            .code,
        TypeMismatch
    );
}

#[tokio::test]
async fn cold_manual_poll_is_not_ready() {
    let client = Client::builder(SDK_KEY)
        .cache_directory(":memory:")
        .polling_mode(PollingMode::ManualPoll)
        .build()
        .unwrap();
    let provider = ConfeatureProvider::new(Arc::new(client)).unwrap();
    let error = provider
        .resolve_bool_value("flag", &EvaluationContext::default())
        .await
        .unwrap_err();
    assert_eq!(error.code, EvaluationErrorCode::ProviderNotReady);
    assert_eq!(
        error.message.as_deref(),
        Some("Confeature configuration is unavailable")
    );
}

#[test]
fn configured_default_user_is_rejected() {
    let client = Client::builder(SDK_KEY)
        .cache_directory(":memory:")
        .polling_mode(PollingMode::ManualPoll)
        .default_user(User::new("default-user-sentinel"))
        .build()
        .unwrap();
    let error = ConfeatureProvider::new(Arc::new(client)).err().unwrap();
    assert_eq!(error.code, EvaluationErrorCode::General("GENERAL".into()));
    assert_eq!(
        error.message.as_deref(),
        Some("Confeature provider requires an SDK client without a default user")
    );
}

#[test]
fn context_maps_only_supported_fields_into_a_new_user() {
    let timestamp = time::OffsetDateTime::from_unix_timestamp_nanos(-250_000_000).unwrap();
    let context = EvaluationContext::default()
        .with_targeting_key("primary")
        .with_custom_field("targetingKey", "shadowed")
        .with_custom_field("Identifier", "shadowed")
        .with_custom_field("Email", "sample@example.invalid")
        .with_custom_field("Country", "FR")
        .with_custom_field("text", "example")
        .with_custom_field("integer", 4_i64)
        .with_custom_field("decimal", 2.5)
        .with_custom_field("boolean", true)
        .with_custom_field("date", timestamp)
        .with_custom_field(
            "roles",
            EvaluationContextFieldValue::new_struct(vec![String::from("read")]),
        )
        .with_custom_field("other", EvaluationContextFieldValue::new_struct(vec![7]))
        .with_custom_field("nonfinite", f64::INFINITY);
    let user = user_from_context(&context).unwrap();
    assert_eq!(user.identifier, "primary");
    assert_eq!(user.email.as_deref(), Some("sample@example.invalid"));
    assert_eq!(user.country.as_deref(), Some("FR"));
    assert_eq!(
        user.custom,
        HashMap::from([
            ("text".into(), UserValue::String("example".into())),
            ("integer".into(), UserValue::Int(4)),
            ("decimal".into(), UserValue::Float(2.5)),
            ("boolean".into(), UserValue::String("true".into())),
            ("date".into(), UserValue::DateTime(-0.25)),
            ("roles".into(), UserValue::StringVec(vec!["read".into()])),
        ])
    );
    let unrelated = EvaluationContext::default()
        .with_custom_field("Email", true)
        .with_custom_field("Country", 7)
        .with_custom_field("Identifier", "shadowed");
    assert!(user_from_context(&unrelated).is_none());
    let empty_key = EvaluationContext::default().with_targeting_key("");
    assert_eq!(user_from_context(&empty_key), Some(User::new("")));
}
