// SPDX-License-Identifier: MIT

//! Targeting context passed alongside flag evaluations.
//!
//! Mirrors the upstream `configcat` crate's `User` semantics — a stable
//! identifier plus optional email, country, and free-form custom
//! attributes. Custom attributes are TYPED ([`UserValue`]) so the
//! evaluator can convert non-string values (numbers, dates, string
//! arrays) to ConfigCat's canonical string exactly as the upstream SDK
//! does (spec 151 / #468).
//!
//! ## Parity note (Principle II)
//!
//! The upstream `configcat::UserValue` enum exposes
//! `String | Int | UInt | Float | DateTime | StringVec | SemVer`. This
//! crate mirrors the variant **names** 1:1 with two deliberate,
//! documented representation choices that avoid pulling new runtime
//! dependencies into the production crate graph (the SDK ships zero
//! third-party deps beyond the ones in `Cargo.toml`):
//!
//! - [`UserValue::DateTime`] holds the date as **Unix epoch seconds**
//!   (`f64`) rather than `chrono::DateTime<Utc>`. ConfigCat converts a
//!   `DateTime` attribute to a second-based Unix timestamp before any
//!   comparison, so the evaluator-visible value is identical; only the
//!   constructor argument differs.
//! - The `SemVer` variant is omitted: every semver-comparator attribute
//!   in the ConfigCat corpus is supplied as a [`UserValue::String`]
//!   carrying the version text (the upstream `SemVer` variant is sugar
//!   over the same string path), so no behaviour is lost.

use std::collections::HashMap;

/// A typed custom-attribute value. Mirrors the variant names of the
/// upstream `configcat::UserValue` enum (Principle II) so a migrating
/// customer's `user.with_custom_value("Rating", 4.5_f64)` call site
/// keeps the same shape.
///
/// In a **text-based** comparison every variant is converted to
/// ConfigCat's canonical string; in a **number / date / array**
/// comparison the variant is consumed in its native type. See the
/// evaluator for the exact conversion rules.
#[derive(Debug, Clone, PartialEq)]
pub enum UserValue {
    /// String attribute value (the default / verbatim path).
    String(String),
    /// Signed-integer attribute value.
    Int(i64),
    /// Unsigned-integer attribute value.
    UInt(u64),
    /// Floating-point attribute value. Carries NaN / ±Infinity, which
    /// stringify to `"NaN"` / `"Infinity"` / `"-Infinity"`.
    Float(f64),
    /// Datetime attribute value as **Unix epoch seconds** (fractional
    /// part preserved). Converted to a second-based Unix timestamp by
    /// every date-time comparator, identical to ConfigCat.
    DateTime(f64),
    /// String-vector attribute value (array-contains comparators, or a
    /// JSON-array string in text comparators).
    StringVec(Vec<String>),
}

impl UserValue {
    /// Returns the verbatim string when this value is a
    /// [`UserValue::String`], for the unchanged string-attribute path.
    /// Test-only helper (the production evaluator bridges through
    /// [`crate::internal::comparators::AttrValue`] instead).
    #[cfg(test)]
    pub(crate) fn as_borrowed_str(&self) -> Option<&str> {
        match self {
            UserValue::String(s) => Some(s),
            _ => None,
        }
    }
}

impl From<String> for UserValue {
    fn from(v: String) -> Self {
        UserValue::String(v)
    }
}

impl From<&str> for UserValue {
    fn from(v: &str) -> Self {
        UserValue::String(v.to_owned())
    }
}

impl From<i64> for UserValue {
    fn from(v: i64) -> Self {
        UserValue::Int(v)
    }
}

impl From<i32> for UserValue {
    fn from(v: i32) -> Self {
        UserValue::Int(v as i64)
    }
}

impl From<u64> for UserValue {
    fn from(v: u64) -> Self {
        UserValue::UInt(v)
    }
}

impl From<u32> for UserValue {
    fn from(v: u32) -> Self {
        UserValue::UInt(v as u64)
    }
}

impl From<f64> for UserValue {
    fn from(v: f64) -> Self {
        UserValue::Float(v)
    }
}

impl From<f32> for UserValue {
    fn from(v: f32) -> Self {
        UserValue::Float(v as f64)
    }
}

impl From<bool> for UserValue {
    /// A boolean attribute stringifies to `"true"` / `"false"` in a text
    /// comparison, exactly as ConfigCat's `userAttributeValueToString`.
    /// The upstream `UserValue` has no dedicated `Bool` variant, so a
    /// bool collapses onto the string path the same way.
    fn from(v: bool) -> Self {
        UserValue::String(if v { "true" } else { "false" }.to_owned())
    }
}

impl From<Vec<String>> for UserValue {
    fn from(v: Vec<String>) -> Self {
        UserValue::StringVec(v)
    }
}

impl From<Vec<&str>> for UserValue {
    fn from(v: Vec<&str>) -> Self {
        UserValue::StringVec(v.into_iter().map(str::to_owned).collect())
    }
}

impl<const N: usize> From<[&str; N]> for UserValue {
    fn from(v: [&str; N]) -> Self {
        UserValue::StringVec(v.iter().map(|s| (*s).to_owned()).collect())
    }
}

/// A targeting context: a stable identifier plus optional email,
/// country, and free-form custom attributes.
///
/// Construct via `Default::default()` + field assignment, or use the
/// fluent builder methods below.
///
/// ```
/// use confeature::User;
///
/// let user = User::new("alice@example.com")
///     .with_email("alice@example.com")
///     .with_country("FR")
///     .with_custom("plan", "pro")
///     .with_custom_value("rating", 4.5_f64);
/// assert_eq!(user.identifier, "alice@example.com");
/// ```
#[derive(Debug, Clone, Default, PartialEq)]
pub struct User {
    /// Stable identifier (e.g. user UUID or email). Required field; an
    /// empty string is a legitimate value — corpora include "empty-id"
    /// tuples.
    pub identifier: String,
    /// Optional email address.
    pub email: Option<String>,
    /// Optional ISO 3166-1 alpha-2 country code.
    pub country: Option<String>,
    /// Free-form typed attributes consumed by targeting rules.
    pub custom: HashMap<String, UserValue>,
}

impl User {
    /// Constructs a [`User`] with the given identifier and empty
    /// optional fields.
    pub fn new(identifier: impl Into<String>) -> Self {
        Self {
            identifier: identifier.into(),
            email: None,
            country: None,
            custom: HashMap::new(),
        }
    }

    /// Sets the user's email and returns `self` for chaining.
    pub fn with_email(mut self, email: impl Into<String>) -> Self {
        self.email = Some(email.into());
        self
    }

    /// Sets the user's country and returns `self` for chaining.
    pub fn with_country(mut self, country: impl Into<String>) -> Self {
        self.country = Some(country.into());
        self
    }

    /// Adds a **string** custom attribute and returns `self` for
    /// chaining. The string path is unchanged from the pre-typed
    /// surface — `with_custom("plan", "pro")` keeps working verbatim.
    pub fn with_custom(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.custom
            .insert(key.into(), UserValue::String(value.into()));
        self
    }

    /// Adds a **typed** custom attribute and returns `self` for
    /// chaining. Mirrors the upstream `configcat::User::custom<T:
    /// Into<UserValue>>` ergonomics:
    ///
    /// ```
    /// use confeature::User;
    ///
    /// let user = User::new("u")
    ///     .with_custom_value("rating", 4.5_f64)
    ///     .with_custom_value("age", 30_i64)
    ///     .with_custom_value("roles", ["read", "write"]);
    /// ```
    pub fn with_custom_value(
        mut self,
        key: impl Into<String>,
        value: impl Into<UserValue>,
    ) -> Self {
        self.custom.insert(key.into(), value.into());
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_sets_only_identifier() {
        let u = User::new("alice");
        assert_eq!(u.identifier, "alice");
        assert!(u.email.is_none());
        assert!(u.country.is_none());
        assert!(u.custom.is_empty());
    }

    #[test]
    fn builders_chain() {
        let u = User::new("alice")
            .with_email("a@b")
            .with_country("FR")
            .with_custom("plan", "pro");
        assert_eq!(u.email.as_deref(), Some("a@b"));
        assert_eq!(u.country.as_deref(), Some("FR"));
        assert_eq!(u.custom.get("plan"), Some(&UserValue::String("pro".into())));
    }

    #[test]
    fn default_is_empty() {
        let u = User::default();
        assert_eq!(u.identifier, "");
        assert!(u.email.is_none());
    }

    #[test]
    fn typed_custom_values_round_trip() {
        let u = User::new("u")
            .with_custom_value("int", 30_i64)
            .with_custom_value("uint", 7_u64)
            .with_custom_value("float", 4.5_f64)
            .with_custom_value("date", UserValue::DateTime(1680307199.999))
            .with_custom_value("roles", ["read", "write"])
            .with_custom_value("flag", true);
        assert_eq!(u.custom.get("int"), Some(&UserValue::Int(30)));
        assert_eq!(u.custom.get("uint"), Some(&UserValue::UInt(7)));
        assert_eq!(u.custom.get("float"), Some(&UserValue::Float(4.5)));
        assert_eq!(
            u.custom.get("date"),
            Some(&UserValue::DateTime(1680307199.999))
        );
        assert_eq!(
            u.custom.get("roles"),
            Some(&UserValue::StringVec(vec!["read".into(), "write".into()]))
        );
        // bool collapses onto the string path (no upstream Bool variant).
        assert_eq!(
            u.custom.get("flag"),
            Some(&UserValue::String("true".into()))
        );
    }

    #[test]
    fn with_custom_keeps_string_path() {
        // The pre-typed `with_custom(k, impl Into<String>)` signature is
        // unchanged — a migrating customer's call sites still compile.
        let u = User::new("u").with_custom("plan", "pro".to_string());
        assert_eq!(
            u.custom.get("plan").and_then(UserValue::as_borrowed_str),
            Some("pro")
        );
    }
}
