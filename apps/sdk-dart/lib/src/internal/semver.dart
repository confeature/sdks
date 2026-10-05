// SPDX-License-Identifier: MIT

/// ConfigCat-semantics semver parse + compare. Ported field-for-field from
/// the spec-117 TS reference (`packages/sdk-shared/src/semver.ts`),
/// cross-checked against the spec-118/119/120/121/122 ports, which themselves
/// vendor ConfigCat `common-js` `Semver.ts`.
///
/// The `pub_semver` package is NOT used — ConfigCat's strict-parse +
/// precedence edge cases diverge from it and would fail the vendored
/// `testmatrix_semantic*` precedence rows, so we vendor the exact semantics.
///
/// Key behaviours:
///   - **Strict (non-loose) parse** of the FULL grammar
///     `v?MAJOR.MINOR.PATCH(-prerelease)?(+build)?`, each core component a
///     `0|[1-9]\d*` numeric identifier; an optional leading `v` is allowed.
///   - **Parse on trim.** Callers parse `value.trim()`; [SemVer.parse] also
///     trims defensively.
///   - **Unparseable → `null`**, never a throw. The caller treats `null` as a
///     validation error (the rule errors and does not match — FR-010), NOT a
///     silent false.
///   - **Precedence**: numeric major.minor.patch first; then pre-release. A
///     version WITHOUT a pre-release ranks HIGHER than one WITH a pre-release.
///     Pre-release identifiers compared field-by-field — numeric vs numeric
///     numerically; a numeric identifier < an alphanumeric identifier;
///     alphanumeric compared ASCII-lexically; when all preceding fields are
///     equal, MORE fields rank higher than fewer.
///   - **Build metadata is ignored** for precedence (SemVer §10).
library;

const String _numericIdentifier = r'0|[1-9]\d*';
const String _nonNumericIdentifier = r'\d*[a-zA-Z-][a-zA-Z0-9-]*';
const int _maxLength = 256;
// Mirrors JS Number.MAX_SAFE_INTEGER (the TS reference's bound).
const int _maxSafeInteger = 9007199254740991;

final RegExp _numericRe = RegExp(r'^[0-9]+$');

final RegExp _full = () {
  const num = _numericIdentifier;
  final main = '($num)\\.($num)\\.($num)';
  final prereleaseId = '(?:$num|$_nonNumericIdentifier)';
  final prerelease = '(?:-($prereleaseId(?:\\.$prereleaseId)*))';
  const buildId = '[0-9A-Za-z-]+';
  const build = '(?:\\+($buildId(?:\\.$buildId)*))';
  return RegExp('^v?$main$prerelease?$build?\$');
}();

/// A parsed semver, with a ConfigCat-precedence [compare].
class SemVer {
  const SemVer._(
    this.version,
    this.major,
    this.minor,
    this.patch,
    this.prerelease,
    this.build,
  );

  /// Canonical `major.minor.patch(-prerelease)?` string.
  final String version;

  /// Numeric major component.
  final int major;

  /// Numeric minor component.
  final int minor;

  /// Numeric patch component.
  final int patch;

  /// Numberified pre-release identifiers (numeric ids become `int`).
  final List<Object> prerelease;

  /// Build-metadata identifiers (ignored for precedence).
  final List<String> build;

  /// Parse [version] under ConfigCat's strict grammar, returning `null` on any
  /// failure (length, grammar, out-of-range core component) — never throwing.
  /// Trims the input first (parse on trim).
  static SemVer? parse(String version) {
    final trimmed = version.trim();
    if (trimmed.length > _maxLength) return null;
    final m = _full.firstMatch(trimmed);
    if (m == null) return null;

    final major = int.parse(m.group(1)!);
    final minor = int.parse(m.group(2)!);
    final patch = int.parse(m.group(3)!);
    if (major < 0 ||
        major > _maxSafeInteger ||
        minor < 0 ||
        minor > _maxSafeInteger ||
        patch < 0 ||
        patch > _maxSafeInteger) {
      return null;
    }

    final prerelease = _parsePrerelease(m.group(4));
    final buildRaw = m.group(5);
    final build = (buildRaw != null && buildRaw.isNotEmpty)
        ? buildRaw.split('.')
        : <String>[];

    var canonical = '$major.$minor.$patch';
    if (prerelease.isNotEmpty) {
      canonical += '-${prerelease.map((e) => e.toString()).join('.')}';
    }
    return SemVer._(canonical, major, minor, patch, prerelease, build);
  }

  static List<Object> _parsePrerelease(String? raw) {
    if (raw == null || raw.isEmpty) return <Object>[];
    final out = <Object>[];
    for (final ident in raw.split('.')) {
      if (_numericRe.hasMatch(ident)) {
        final numVal = int.tryParse(ident);
        if (numVal != null && numVal >= 0 && numVal < _maxSafeInteger) {
          out.add(numVal);
          continue;
        }
      }
      out.add(ident);
    }
    return out;
  }

  /// Compare against [other]: `<0` lower, `0` equal, `>0` higher. Build
  /// metadata is ignored. Mirrors `semver.ts::SemVer.compare`.
  int compare(SemVer other) {
    if (other.version == version) return 0;
    final main = _compareMain(other);
    return main != 0 ? main : _comparePre(other);
  }

  int _compareMain(SemVer other) {
    var c = _compareIdentifiers(major, other.major);
    if (c != 0) return c;
    c = _compareIdentifiers(minor, other.minor);
    if (c != 0) return c;
    return _compareIdentifiers(patch, other.patch);
  }

  int _comparePre(SemVer other) {
    // A version WITHOUT a pre-release is higher-precedence than one WITH.
    if (prerelease.isNotEmpty && other.prerelease.isEmpty) return -1;
    if (prerelease.isEmpty && other.prerelease.isNotEmpty) return 1;
    if (prerelease.isEmpty && other.prerelease.isEmpty) return 0;

    var i = 0;
    while (true) {
      final a = i < prerelease.length ? prerelease[i] : null;
      final b = i < other.prerelease.length ? other.prerelease[i] : null;
      if (a == null && b == null) return 0;
      if (b == null) return 1;
      if (a == null) return -1;
      if (a == b) {
        i++;
        continue;
      }
      return _compareIdentifiers(a, b);
    }
  }
}

/// Compare two pre-release / core identifiers (common-js `compareIdentifiers`):
/// both numeric → numeric compare; a numeric identifier is lower-precedence
/// than an alphanumeric one; otherwise ASCII-lexical.
int _compareIdentifiers(Object a, Object b) {
  final anum = _numericRe.hasMatch(a.toString());
  final bnum = _numericRe.hasMatch(b.toString());
  Object av = a;
  Object bv = b;
  if (anum && bnum) {
    av = a is int ? a : int.parse(a.toString());
    bv = b is int ? b : int.parse(b.toString());
  }
  if (av == bv) return 0;
  if (anum && !bnum) return -1;
  if (bnum && !anum) return 1;
  if (av is int && bv is int) return av < bv ? -1 : 1;
  return av.toString().compareTo(bv.toString()) < 0 ? -1 : 1;
}

/// Functional shorthand for [SemVer.parse].
SemVer? parseSemVer(String version) => SemVer.parse(version);
