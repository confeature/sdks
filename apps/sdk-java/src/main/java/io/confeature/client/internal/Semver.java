// SPDX-License-Identifier: MIT
package io.confeature.client.internal;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * ConfigCat-semantics semver parse + compare, ported field-for-field from {@code
 * packages/sdk-shared/src/semver.ts} (the spec-117 reference, itself a port of ConfigCat common-js
 * {@code Semver.ts}).
 *
 * <p>A Maven semver library is deliberately NOT used — npm/other-lib precedence diverges from
 * ConfigCat on loose-parse and pre-release edge cases and would fail the vendored {@code
 * testmatrix_semantic*} rows.
 *
 * <p>Key behaviours: strict (non-loose) FULL grammar with an optional leading {@code v}; parse on
 * trim; unparseable → {@code null} (never a throw — the caller treats {@code null} as a validation
 * error); a version WITHOUT a pre-release ranks HIGHER than one WITH; build metadata is ignored for
 * precedence.
 */
final class Semver {

  private static final String NUMERIC_IDENTIFIER = "0|[1-9]\\d*";
  private static final String NON_NUMERIC_IDENTIFIER = "\\d*[a-zA-Z-][a-zA-Z0-9-]*";
  private static final String MAIN_VERSION =
      "(" + NUMERIC_IDENTIFIER + ")\\.(" + NUMERIC_IDENTIFIER + ")\\.(" + NUMERIC_IDENTIFIER + ")";
  private static final String PRERELEASE_IDENTIFIER =
      "(?:" + NUMERIC_IDENTIFIER + "|" + NON_NUMERIC_IDENTIFIER + ")";
  private static final String PRERELEASE =
      "(?:-(" + PRERELEASE_IDENTIFIER + "(?:\\." + PRERELEASE_IDENTIFIER + ")*))";
  private static final String BUILD_IDENTIFIER = "[0-9A-Za-z-]+";
  private static final String BUILD =
      "(?:\\+(" + BUILD_IDENTIFIER + "(?:\\." + BUILD_IDENTIFIER + ")*))";
  private static final Pattern FULL =
      Pattern.compile("^v?" + MAIN_VERSION + PRERELEASE + "?" + BUILD + "?$");

  private static final int MAX_LENGTH = 256;
  private static final long MAX_SAFE_INTEGER = 9007199254740991L;
  private static final Pattern NUMERIC_RE = Pattern.compile("^[0-9]+$");

  private final String version;
  private final long major;
  private final long minor;
  private final long patch;

  /** Pre-release identifiers — each either a {@link Long} (numeric) or a {@link String}. */
  private final List<Object> prerelease;

  private Semver(String version, long major, long minor, long patch, List<Object> prerelease) {
    this.version = version;
    this.major = major;
    this.minor = minor;
    this.patch = patch;
    this.prerelease = prerelease;
  }

  /**
   * Parse a version string under ConfigCat's strict grammar, returning {@code null} on any failure
   * (length, grammar, out-of-range core component) — never throwing. Trims the input first.
   */
  static Semver parse(String input) {
    if (input == null) {
      return null;
    }
    final String trimmed = input.trim();
    if (trimmed.length() > MAX_LENGTH) {
      return null;
    }
    final Matcher m = FULL.matcher(trimmed);
    if (!m.matches()) {
      return null;
    }

    final long major = Long.parseLong(m.group(1));
    final long minor = Long.parseLong(m.group(2));
    final long patch = Long.parseLong(m.group(3));
    if (major > MAX_SAFE_INTEGER
        || major < 0
        || minor > MAX_SAFE_INTEGER
        || minor < 0
        || patch > MAX_SAFE_INTEGER
        || patch < 0) {
      return null;
    }

    final List<Object> prerelease = new ArrayList<>();
    if (m.group(4) != null) {
      for (final String id : m.group(4).split("\\.")) {
        if (NUMERIC_RE.matcher(id).matches()) {
          // Guard against overflow / leading-zero numeric ids the way the TS
          // numberifier does (range-checked); otherwise keep as a string.
          try {
            final long num = Long.parseLong(id);
            if (num >= 0 && num < MAX_SAFE_INTEGER) {
              prerelease.add(num);
              continue;
            }
          } catch (NumberFormatException ignored) {
            // Falls through to string identifier below.
          }
        }
        prerelease.add(id);
      }
    }

    final StringBuilder canonical = new StringBuilder();
    canonical.append(major).append('.').append(minor).append('.').append(patch);
    if (!prerelease.isEmpty()) {
      canonical.append('-');
      for (int i = 0; i < prerelease.size(); i++) {
        if (i > 0) {
          canonical.append('.');
        }
        canonical.append(prerelease.get(i));
      }
    }
    return new Semver(canonical.toString(), major, minor, patch, prerelease);
  }

  /**
   * Compare against {@code other}: {@code <0} if this is lower-precedence, {@code 0} if equal,
   * {@code >0} if higher. Build metadata is ignored.
   */
  int compare(Semver other) {
    if (other.version.equals(this.version)) {
      return 0;
    }
    final int main = compareMain(other);
    return main != 0 ? main : comparePre(other);
  }

  private int compareMain(Semver other) {
    int c = compareIdentifiers(this.major, other.major);
    if (c != 0) {
      return c;
    }
    c = compareIdentifiers(this.minor, other.minor);
    if (c != 0) {
      return c;
    }
    return compareIdentifiers(this.patch, other.patch);
  }

  private int comparePre(Semver other) {
    final boolean thisHas = !this.prerelease.isEmpty();
    final boolean otherHas = !other.prerelease.isEmpty();
    if (thisHas && !otherHas) {
      return -1;
    }
    if (!thisHas && otherHas) {
      return 1;
    }
    if (!thisHas && !otherHas) {
      return 0;
    }

    int i = 0;
    while (true) {
      final Object a = i < this.prerelease.size() ? this.prerelease.get(i) : null;
      final Object b = i < other.prerelease.size() ? other.prerelease.get(i) : null;
      if (a == null && b == null) {
        return 0;
      }
      if (b == null) {
        return 1;
      }
      if (a == null) {
        return -1;
      }
      if (a.equals(b)) {
        i++;
        continue;
      }
      return compareIdentifiers(a, b);
    }
  }

  /**
   * Compare two identifiers exactly as common-js {@code compareIdentifiers}: both numeric → numeric
   * compare; a numeric identifier is lower-precedence than an alphanumeric one; otherwise
   * ASCII-lexical.
   */
  private static int compareIdentifiers(Object a, Object b) {
    final boolean anum = a instanceof Long || NUMERIC_RE.matcher(String.valueOf(a)).matches();
    final boolean bnum = b instanceof Long || NUMERIC_RE.matcher(String.valueOf(b)).matches();
    if (anum && bnum) {
      final long av = a instanceof Long ? (Long) a : Long.parseLong(String.valueOf(a));
      final long bv = b instanceof Long ? (Long) b : Long.parseLong(String.valueOf(b));
      return Long.compare(av, bv);
    }
    if (String.valueOf(a).equals(String.valueOf(b))) {
      return 0;
    }
    if (anum) {
      return -1;
    }
    if (bnum) {
      return 1;
    }
    return String.valueOf(a).compareTo(String.valueOf(b)) < 0 ? -1 : 1;
  }
}
