// SPDX-License-Identifier: MIT

//! Cross-language SDK-key shape gate (#802, FR-004).
//!
//! Consumes `packages/test-fixtures-sdk-parity/fixtures/sdk-key-shapes.json`
//! — the ONE list of key shapes every Confeature SDK validator reads, never a
//! per-SDK copy — and asserts that [`confeature::is_valid_confeature_key_format`]
//! accepts every `valid` entry and rejects every `invalid` one. Mirrors
//! `packages/sdk-shared/tests/unit/sdk-key.test.ts`.
//!
//! Failure messages name the fixture entry and show only the redacted key.

mod common;

use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct Shape {
    name: String,
    key: String,
}

#[derive(Debug, Deserialize)]
struct Shapes {
    valid: Vec<Shape>,
    invalid: Vec<Shape>,
}

fn load() -> Shapes {
    let path = common::sdk_key_shapes_path();
    let raw =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parse sdk-key-shapes.json: {e}"))
}

#[test]
fn accepts_every_valid_shape() {
    let shapes = load();
    assert!(
        !shapes.valid.is_empty(),
        "sdk-key-shapes.json has no valid entries"
    );
    // Both shapes must be represented, or the gate proves only one of them.
    assert!(shapes
        .valid
        .iter()
        .any(|s| s.key.starts_with("configcat-sdk-1/")));
    assert!(shapes
        .valid
        .iter()
        .any(|s| s.key.starts_with("confeature-sdk-1-")));
    for s in &shapes.valid {
        assert!(
            confeature::is_valid_confeature_key_format(&s.key),
            "valid shape {:?} rejected (key: {})",
            s.name,
            confeature::redact_sdk_key(&s.key),
        );
    }
}

#[test]
fn rejects_every_invalid_shape() {
    let shapes = load();
    assert!(
        !shapes.invalid.is_empty(),
        "sdk-key-shapes.json has no invalid entries"
    );
    for s in &shapes.invalid {
        assert!(
            !confeature::is_valid_confeature_key_format(&s.key),
            "invalid shape {:?} accepted (key: {})",
            s.name,
            confeature::redact_sdk_key(&s.key),
        );
    }
}

#[test]
fn redaction_never_shows_a_whole_secret_segment() {
    // The `/` in a ConfigCat-shaped key is an ordinary character to the
    // redactor: neither 22-char secret segment may survive redaction.
    for s in load().valid {
        let redacted = confeature::redact_sdk_key(&s.key);
        assert!(redacted.contains("[redacted]"), "{:?} not masked", s.name);
        if let Some(rest) = s.key.strip_prefix("configcat-sdk-1/") {
            for segment in rest.split('/') {
                assert!(
                    !redacted.contains(segment),
                    "{:?}: a whole secret segment survived redaction",
                    s.name
                );
            }
        }
    }
}
