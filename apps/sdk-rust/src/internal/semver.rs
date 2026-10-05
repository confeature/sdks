// SPDX-License-Identifier: MIT

//! ConfigCat-semantics semver parse + compare — port of
//! `packages/sdk-shared/src/semver.ts` (spec 125, research §R3).
//!
//! Ported field-for-field from ConfigCat `common-js` `Semver.ts`. The
//! `semver` crate is deliberately NOT used: its loose-parse + precedence
//! edge cases diverge from ConfigCat and would fail the vendored
//! `testmatrix_semantic*` rows.
//!
//! Key behaviours:
//!
//! - **Strict (non-loose) parse**: `v?MAJOR.MINOR.PATCH(-pre)?(+build)?`,
//!   each core component `0|[1-9]\d*` (no leading zeros), an optional
//!   leading `v`.
//! - **Parse on trim** — the input is trimmed first.
//! - **Unparseable → `None`**, never a panic. The caller treats `None`
//!   as a validation error (rule no-match + surfaced error).
//! - **Precedence**: numeric `major.minor.patch` first; then pre-release.
//!   A version WITHOUT a pre-release ranks HIGHER than one WITH. Pre-
//!   release identifiers compared field-by-field — numeric vs numeric
//!   numerically; numeric identifier < alphanumeric identifier;
//!   alphanumeric ASCII-lexically; when all preceding fields equal, MORE
//!   fields rank higher than fewer.
//! - **Build metadata is ignored** for precedence (SemVer §10).

use std::cmp::Ordering;

const MAX_LENGTH: usize = 256;
/// `Number.MAX_SAFE_INTEGER` (matches the TS reference bound).
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// A single pre-release identifier: numeric (`0|[1-9]\d*`, within the
/// safe-integer range) or an alphanumeric string.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Identifier {
    Numeric(u64),
    Alpha(String),
}

/// A parsed semantic version with ConfigCat-precedence ordering.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SemVer {
    /// Canonical `major.minor.patch[-pre]` (build metadata dropped).
    version: String,
    major: u64,
    minor: u64,
    patch: u64,
    prerelease: Vec<Identifier>,
}

/// True iff `s` is a non-empty run of ASCII digits.
fn is_numeric(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

/// True iff a core component matches `0|[1-9]\d*` (no leading zeros).
fn is_numeric_identifier(s: &str) -> bool {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    s == "0" || !s.starts_with('0')
}

/// True iff a pre-release identifier matches `\d*[a-zA-Z-][a-zA-Z0-9-]*`.
fn is_non_numeric_identifier(s: &str) -> bool {
    if s.is_empty() {
        return false;
    }
    let bytes = s.as_bytes();
    // Leading `\d*`.
    let mut i = 0;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    // Then at least one `[a-zA-Z-]`.
    if i >= bytes.len() {
        return false;
    }
    let c = bytes[i];
    if !(c.is_ascii_alphabetic() || c == b'-') {
        return false;
    }
    i += 1;
    // Rest `[a-zA-Z0-9-]*`.
    while i < bytes.len() {
        let c = bytes[i];
        if !(c.is_ascii_alphanumeric() || c == b'-') {
            return false;
        }
        i += 1;
    }
    true
}

/// True iff a build identifier matches `[0-9A-Za-z-]+`.
fn is_build_identifier(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// Compare two identifiers exactly as common-js `compareIdentifiers`:
/// both numeric → numeric compare; a numeric identifier is lower-
/// precedence than an alphanumeric one; otherwise ASCII-lexical.
fn compare_identifiers(a: &Identifier, b: &Identifier) -> Ordering {
    match (a, b) {
        (Identifier::Numeric(x), Identifier::Numeric(y)) => x.cmp(y),
        // Numeric identifier is lower-precedence than alphanumeric.
        (Identifier::Numeric(_), Identifier::Alpha(_)) => Ordering::Less,
        (Identifier::Alpha(_), Identifier::Numeric(_)) => Ordering::Greater,
        (Identifier::Alpha(x), Identifier::Alpha(y)) => x.cmp(y),
    }
}

impl SemVer {
    /// Parse a version under ConfigCat's strict grammar, returning `None`
    /// on any failure (length, grammar, out-of-range core) — never panics.
    /// Trims the input first.
    pub(crate) fn parse(version: &str) -> Option<SemVer> {
        let trimmed = version.trim();
        if trimmed.len() > MAX_LENGTH {
            return None;
        }

        // Strip an optional leading `v`.
        let body = trimmed.strip_prefix('v').unwrap_or(trimmed);

        // Split off build metadata (`+...`), then pre-release (`-...`).
        let (without_build, build) = match body.split_once('+') {
            Some((core_pre, build)) => (core_pre, Some(build)),
            None => (body, None),
        };
        let (core, pre) = match without_build.split_once('-') {
            Some((core, pre)) => (core, Some(pre)),
            None => (without_build, None),
        };

        // Validate build metadata (parsed but ignored for precedence).
        if let Some(build) = build {
            if build.is_empty() || build.split('.').any(|id| !is_build_identifier(id)) {
                return None;
            }
        }

        // Core MAJOR.MINOR.PATCH.
        let mut parts = core.split('.');
        let major_s = parts.next()?;
        let minor_s = parts.next()?;
        let patch_s = parts.next()?;
        if parts.next().is_some() {
            return None;
        }
        if !is_numeric_identifier(major_s)
            || !is_numeric_identifier(minor_s)
            || !is_numeric_identifier(patch_s)
        {
            return None;
        }
        let major = major_s.parse::<u64>().ok()?;
        let minor = minor_s.parse::<u64>().ok()?;
        let patch = patch_s.parse::<u64>().ok()?;
        if major > MAX_SAFE_INTEGER || minor > MAX_SAFE_INTEGER || patch > MAX_SAFE_INTEGER {
            return None;
        }

        // Pre-release identifiers.
        let prerelease = match pre {
            None => Vec::new(),
            Some(pre) => {
                let mut ids = Vec::new();
                for id in pre.split('.') {
                    let numeric = is_numeric_identifier(id);
                    let non_numeric = is_non_numeric_identifier(id);
                    if !numeric && !non_numeric {
                        return None;
                    }
                    // Numberify numeric ids within the safe-integer range
                    // (matching common-js); otherwise keep as a string.
                    if is_numeric(id) {
                        if let Ok(num) = id.parse::<u64>() {
                            if num < MAX_SAFE_INTEGER {
                                ids.push(Identifier::Numeric(num));
                                continue;
                            }
                        }
                    }
                    ids.push(Identifier::Alpha(id.to_string()));
                }
                ids
            }
        };

        let mut canonical = format!("{major}.{minor}.{patch}");
        if !prerelease.is_empty() {
            canonical.push('-');
            let joined: Vec<String> = prerelease
                .iter()
                .map(|id| match id {
                    Identifier::Numeric(n) => n.to_string(),
                    Identifier::Alpha(s) => s.clone(),
                })
                .collect();
            canonical.push_str(&joined.join("."));
        }

        Some(SemVer {
            version: canonical,
            major,
            minor,
            patch,
            prerelease,
        })
    }

    /// Compare against `other`: `Less` if lower-precedence, `Equal` if
    /// equal, `Greater` if higher. Build metadata is ignored. Mirrors
    /// common-js `SemVer.compare` → `compareMain || comparePre`.
    pub(crate) fn compare(&self, other: &SemVer) -> Ordering {
        if other.version == self.version {
            return Ordering::Equal;
        }
        self.compare_main(other)
            .then_with(|| self.compare_pre(other))
    }

    fn compare_main(&self, other: &SemVer) -> Ordering {
        self.major
            .cmp(&other.major)
            .then(self.minor.cmp(&other.minor))
            .then(self.patch.cmp(&other.patch))
    }

    fn compare_pre(&self, other: &SemVer) -> Ordering {
        // A version WITHOUT a pre-release is higher-precedence than one
        // WITH (note: returned values mirror common-js exactly).
        match (self.prerelease.is_empty(), other.prerelease.is_empty()) {
            (false, true) => return Ordering::Less,
            (true, false) => return Ordering::Greater,
            (true, true) => return Ordering::Equal,
            (false, false) => {}
        }

        let mut i = 0;
        loop {
            let a = self.prerelease.get(i);
            let b = other.prerelease.get(i);
            match (a, b) {
                (None, None) => return Ordering::Equal,
                (Some(_), None) => return Ordering::Greater,
                (None, Some(_)) => return Ordering::Less,
                (Some(a), Some(b)) => {
                    if a == b {
                        i += 1;
                        continue;
                    }
                    return compare_identifiers(a, b);
                }
            }
        }
    }
}

/// Functional shorthand for [`SemVer::parse`].
pub(crate) fn parse_semver(version: &str) -> Option<SemVer> {
    SemVer::parse(version)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cmp::Ordering;

    fn cmp(a: &str, b: &str) -> Ordering {
        parse_semver(a).unwrap().compare(&parse_semver(b).unwrap())
    }

    #[test]
    fn parses_basic_and_leading_v() {
        assert!(parse_semver("1.2.3").is_some());
        assert!(parse_semver("v1.2.3").is_some());
        assert!(parse_semver(" 1.0.0 ").is_some());
    }

    #[test]
    fn rejects_invalid() {
        assert!(parse_semver("1.2").is_none());
        assert!(parse_semver("01.2.3").is_none()); // leading zero
        assert!(parse_semver("1.2.3.4").is_none());
        assert!(parse_semver("not-a-version").is_none());
        assert!(parse_semver("1.2.3-").is_none());
        assert!(parse_semver("1.2.3+").is_none());
    }

    #[test]
    fn core_precedence() {
        assert_eq!(cmp("1.0.0", "2.0.0"), Ordering::Less);
        assert_eq!(cmp("2.1.0", "2.0.9"), Ordering::Greater);
        assert_eq!(cmp("1.2.3", "1.2.3"), Ordering::Equal);
    }

    #[test]
    fn prerelease_lower_than_release() {
        assert_eq!(cmp("1.0.0-alpha", "1.0.0"), Ordering::Less);
        assert_eq!(cmp("1.0.0", "1.0.0-alpha"), Ordering::Greater);
    }

    #[test]
    fn prerelease_field_by_field() {
        // Canonical SemVer §11 precedence chain.
        assert_eq!(cmp("1.0.0-alpha", "1.0.0-alpha.1"), Ordering::Less);
        assert_eq!(cmp("1.0.0-alpha.1", "1.0.0-alpha.beta"), Ordering::Less);
        assert_eq!(cmp("1.0.0-alpha.beta", "1.0.0-beta"), Ordering::Less);
        assert_eq!(cmp("1.0.0-beta", "1.0.0-beta.2"), Ordering::Less);
        assert_eq!(cmp("1.0.0-beta.2", "1.0.0-beta.11"), Ordering::Less);
        assert_eq!(cmp("1.0.0-beta.11", "1.0.0-rc.1"), Ordering::Less);
        assert_eq!(cmp("1.0.0-rc.1", "1.0.0"), Ordering::Less);
    }

    #[test]
    fn build_metadata_ignored() {
        assert_eq!(cmp("1.0.0+build1", "1.0.0+build2"), Ordering::Equal);
        assert_eq!(cmp("1.0.0-alpha+x", "1.0.0-alpha+y"), Ordering::Equal);
    }
}
