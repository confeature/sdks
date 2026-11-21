// SPDX-License-Identifier: MIT

mod fixture;

use confeature::{openfeature::ConfeatureProvider, Client, PollingMode, User};
use fixture::{Fixture, TARGETED};
use open_feature::{
    provider::NoOpProvider, Client as FeatureClient, EvaluationContext, EvaluationErrorCode,
    OpenFeature, StructValue,
};
use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tokio::runtime::{Builder, Handle};

const DOMAIN: &str = "confeature-packed-fixture";
const OTHER_DOMAIN: &str = "confeature-packed-other";

fn main() {
    let fixture = Fixture::new();
    let runtime = Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        fixture.check_transport().await;
        manual(&fixture).await;
        auto(&fixture).await;
        lazy(&fixture, false).await;
        lazy(&fixture, true).await;
        cancellation(&fixture).await;
        assert_eq!(fixture.served().await, 6);
        println!("Rust packed OpenFeature provider passed in Tokio");
    });
    async_std::task::block_on(async {
        assert!(Handle::try_current().is_err());
        runtime
            .handle()
            .spawn(async move {
                assert!(Handle::try_current().is_ok());
                manual(&fixture).await;
                assert_eq!(fixture.served().await, 7);
            })
            .await
            .unwrap();
        println!("Rust packed OpenFeature provider passed from an async-std caller");
    });
}

async fn manual(fixture: &Fixture) {
    let before = fixture.served().await;
    let cache = tempfile::tempdir().unwrap();
    let evals = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&evals);
    let sdk = Arc::new(
        fixture
            .client(PollingMode::ManualPoll, cache.path())
            .on_flag_evaluated(move |_| {
                counted.fetch_add(1, Ordering::Relaxed);
            })
            .build()
            .unwrap(),
    );
    let official = register(DOMAIN, &sdk).await;
    assert_eq!(evals.load(Ordering::Relaxed), 0);
    assert_eq!(
        official
            .get_string_details(TARGETED, None, None)
            .await
            .unwrap_err()
            .code,
        EvaluationErrorCode::ProviderNotReady
    );
    assert_eq!(fixture.served().await, before);
    assert_eq!(evals.load(Ordering::Relaxed), 1);

    sdk.force_refresh().await.unwrap();
    assert_targeting(&official).await;
    assert_types(&official).await;
    assert_eq!(evals.load(Ordering::Relaxed), 11);
    measure_warm(&sdk, &official).await;
    sdk.offline();
    assert_targeting(&official).await;
    assert_eq!(fixture.served().await - before, 1);
    finish(sdk).await;
}

async fn auto(fixture: &Fixture) {
    let before = fixture.served().await;
    let cache = tempfile::tempdir().unwrap();
    fixture.fault("5xx").await;
    let sdk = Arc::new(
        fixture
            .client(PollingMode::auto_poll_default(), cache.path())
            .build()
            .unwrap(),
    );
    let official = register(DOMAIN, &sdk).await;
    fixture.wait_for_requests(before + 1).await;
    assert_eq!(
        official
            .get_string_details(TARGETED, None, None)
            .await
            .unwrap_err()
            .code,
        EvaluationErrorCode::ProviderNotReady
    );
    fixture.fault("none").await;
    sdk.force_refresh().await.unwrap();
    assert_targeting(&official).await;
    assert_eq!(fixture.served().await - before, 2);
    finish(sdk).await;
}

async fn lazy(fixture: &Fixture, through_provider: bool) {
    let before = fixture.served().await;
    let cache = tempfile::tempdir().unwrap();
    let sdk = Arc::new(
        fixture
            .client(PollingMode::lazy_load_default(), cache.path())
            .build()
            .unwrap(),
    );
    let official = register(DOMAIN, &sdk).await;
    assert_eq!(fixture.served().await, before);
    tokio::time::timeout(Duration::from_secs(4), async {
        // The native builder registers LazyLoad's callback asynchronously.
        loop {
            let ready = if through_provider {
                match official.get_string_value(TARGETED, None, None).await {
                    Ok(value) => value == "Cat",
                    Err(error) => {
                        assert_eq!(error.code, EvaluationErrorCode::ProviderNotReady);
                        false
                    }
                }
            } else {
                let details = sdk.get_value_details(TARGETED, String::new(), None).await;
                details.value == "Cat"
            };
            if ready {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the first lazy evaluation did not load the fixture");
    assert_targeting(&official).await;
    assert_eq!(fixture.served().await - before, 1);
    finish(sdk).await;
}

async fn cancellation(fixture: &Fixture) {
    let before = fixture.served().await;
    let cache = tempfile::tempdir().unwrap();
    let sdk = Arc::new(fixture.delaying_client(cache.path()).build().unwrap());
    let official = register(DOMAIN, &sdk).await;
    let pending = tokio::spawn(async move {
        loop {
            match official.get_string_details(TARGETED, None, None).await {
                Err(error) if error.code == EvaluationErrorCode::ProviderNotReady => {
                    tokio::task::yield_now().await;
                }
                result => return result,
            }
        }
    });
    fixture.wait_for_requests(before + 1).await;
    pending.abort();
    assert!(pending.await.unwrap_err().is_cancelled());
    fixture.wait_for_cancellation().await;
    assert_eq!(fixture.served().await - before, 1);
    let untouched = sdk
        .snapshot()
        .get_value_details(TARGETED, String::new(), None);
    assert_eq!(untouched.error.as_deref(), Some("NO_CONFIG"));
    close(sdk).await;
}

async fn register(domain: &str, sdk: &Arc<Client>) -> FeatureClient {
    let mut api = OpenFeature::singleton_mut().await;
    api.set_named_provider(domain, ConfeatureProvider::new(Arc::clone(sdk)).unwrap())
        .await;
    api.create_named_client(domain)
}

async fn deregister(domain: &str) {
    OpenFeature::singleton_mut()
        .await
        .set_named_provider(domain, NoOpProvider::default())
        .await;
}

async fn finish(sdk: Arc<Client>) {
    let other_client = register(OTHER_DOMAIN, &sdk).await;
    deregister(DOMAIN).await;
    assert_eq!(
        other_client
            .get_string_value(TARGETED, None, None)
            .await
            .unwrap(),
        "Cat"
    );
    deregister(OTHER_DOMAIN).await;
    let user = User::new("fixture-reader").with_custom("Custom1", "admin");
    let details = sdk
        .get_value_details(TARGETED, String::new(), Some(&user))
        .await;
    assert_eq!(details.value, "Dog");
    assert_eq!(details.variation_id.as_deref(), Some("5b64d9b4"));
    Arc::try_unwrap(sdk)
        .expect("the domain retained the SDK client")
        .close();
}

async fn close(sdk: Arc<Client>) {
    deregister(DOMAIN).await;
    Arc::try_unwrap(sdk)
        .expect("the domain retained the SDK client")
        .close();
}

async fn assert_targeting(client: &FeatureClient) {
    let admin = EvaluationContext::default()
        .with_targeting_key("fixture-reader")
        .with_custom_field("Custom1", "admin");
    let dog = client
        .get_string_details(TARGETED, Some(&admin), None)
        .await
        .unwrap();
    let cat = client
        .get_string_details(TARGETED, None, None)
        .await
        .unwrap();
    assert_eq!(
        (dog.value.as_str(), dog.variant.as_deref()),
        ("Dog", Some("5b64d9b4"))
    );
    assert_eq!(
        (cat.value.as_str(), cat.variant.as_deref()),
        ("Cat", Some("83372510"))
    );
    assert_eq!(
        client
            .get_string_value(TARGETED, Some(&admin), None)
            .await
            .unwrap_or_else(|_| "unresolved".to_owned()),
        "Dog"
    );
}

async fn measure_warm(sdk: &Client, client: &FeatureClient) {
    const SAMPLES: u128 = 128;
    let user = User::new("fixture-reader").with_custom("Custom1", "admin");
    let context = EvaluationContext::default()
        .with_targeting_key("fixture-reader")
        .with_custom_field("Custom1", "admin");
    let native = Instant::now();
    for _ in 0..SAMPLES {
        let details = sdk
            .get_value_details(TARGETED, String::new(), Some(&user))
            .await;
        assert_eq!(std::hint::black_box(details.value), "Dog");
    }
    let native_ns = native.elapsed().as_nanos() / SAMPLES;
    let provider = Instant::now();
    for _ in 0..SAMPLES {
        let details = client
            .get_string_details(TARGETED, Some(&context), None)
            .await
            .unwrap();
        assert_eq!(std::hint::black_box(details.value), "Dog");
    }
    println!(
        "Rust warm fixture over {SAMPLES} calls: native prebuilt User {native_ns} ns/call, official OpenFeature {} ns/call",
        provider.elapsed().as_nanos() / SAMPLES
    );
}

async fn assert_types(client: &FeatureClient) {
    assert!(!client.get_bool_value("boolean", None, None).await.unwrap());
    assert_eq!(
        client.get_int_value("whole", None, None).await.unwrap(),
        999999
    );
    assert_eq!(
        client.get_float_value("decimal", None, None).await.unwrap(),
        0.0
    );
    let missing = client
        .get_bool_value("missing-synthetic-flag", None, None)
        .await
        .unwrap_err();
    let int_as_float = client
        .get_float_value("whole", None, None)
        .await
        .unwrap_err();
    let float_as_int = client
        .get_int_value("decimal", None, None)
        .await
        .unwrap_err();
    let bool_as_int = client
        .get_int_value("boolean", None, None)
        .await
        .unwrap_err();
    let object = client
        .get_struct_details::<StructValue>(TARGETED, None, None)
        .await
        .unwrap_err();
    assert_eq!(missing.code, EvaluationErrorCode::FlagNotFound);
    assert_eq!(int_as_float.code, EvaluationErrorCode::TypeMismatch);
    assert_eq!(float_as_int.code, EvaluationErrorCode::TypeMismatch);
    assert_eq!(bool_as_int.code, EvaluationErrorCode::TypeMismatch);
    assert_eq!(object.code, EvaluationErrorCode::TypeMismatch);
}
