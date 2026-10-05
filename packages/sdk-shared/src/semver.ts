// SPDX-License-Identifier: MIT

/**
 * ConfigCat-semantics semver parse + compare (research.md §R3).
 *
 * Ported field-for-field from ConfigCat `common-js`
 * (`github.com/configcat/common-js`, `src/Semver.ts`), which itself vendors
 * a small parser/compare rather than depending on npm `semver`. The npm
 * package diverges from ConfigCat on loose-parse and precedence edge cases
 * and would fail the vendored `testmatrix_semantic*` precedence rows, so we
 * vendor the exact semantics instead.
 *
 * Key behaviours (verified against `common-js` `Semver.ts` + the way
 * `RolloutEvaluator.ts` invokes `parse(value.trim())`):
 *
 *   - **Strict (non-loose) parse.** The semver comparators call the upstream
 *     `parse` with default options, i.e. the strict `FULL` grammar:
 *     `v?MAJOR.MINOR.PATCH(-prerelease)?(+build)?`, each core component a
 *     `0|[1-9]\d*` numeric identifier. An optional leading `v` is allowed.
 *   - **Parse on trim.** Callers parse `value.trim()`; {@link parseSemVer}
 *     also trims defensively so a stray surrounding space never produces a
 *     false non-match.
 *   - **Unparseable → `null`**, never a throw. The caller treats `null` as a
 *     validation error (the whole condition errors and the rule does not
 *     match — research.md §R5 / FR-010), NOT as a silent `false`.
 *   - **Precedence**: numeric `major.minor.patch` first; then pre-release.
 *     A version WITHOUT a pre-release ranks HIGHER than one WITH a
 *     pre-release. Pre-release identifiers are compared field-by-field —
 *     numeric vs numeric numerically; numeric identifier < alphanumeric
 *     identifier; alphanumeric compared ASCII-lexically; when all preceding
 *     fields are equal, MORE fields rank higher than fewer.
 *   - **Build metadata is ignored** for precedence (SemVer §10).
 */

// MAJOR.MINOR.PATCH where each core component is `0|[1-9]\d*` (no leading
// zeros), an optional leading `v`, an optional `-prerelease` of dot-separated
// `0|[1-9]\d*` or `\d*[a-zA-Z-][a-zA-Z0-9-]*` identifiers, and an optional
// `+build` of dot-separated `[0-9A-Za-z-]+` identifiers. Mirrors the
// common-js `FULL` token.
const NUMERIC_IDENTIFIER = "0|[1-9]\\d*";
const NON_NUMERIC_IDENTIFIER = "\\d*[a-zA-Z-][a-zA-Z0-9-]*";
const MAIN_VERSION = `(${NUMERIC_IDENTIFIER})\\.(${NUMERIC_IDENTIFIER})\\.(${NUMERIC_IDENTIFIER})`;
const PRERELEASE_IDENTIFIER = `(?:${NUMERIC_IDENTIFIER}|${NON_NUMERIC_IDENTIFIER})`;
const PRERELEASE = `(?:-(${PRERELEASE_IDENTIFIER}(?:\\.${PRERELEASE_IDENTIFIER})*))`;
const BUILD_IDENTIFIER = "[0-9A-Za-z-]+";
const BUILD = `(?:\\+(${BUILD_IDENTIFIER}(?:\\.${BUILD_IDENTIFIER})*))`;
const FULL = new RegExp(`^v?${MAIN_VERSION}${PRERELEASE}?${BUILD}?$`);

const MAX_LENGTH = 256;
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER || 9007199254740991;

const numericRe = /^[0-9]+$/;

/**
 * Compare two pre-release / core identifiers exactly as common-js
 * `compareIdentifiers`: both numeric → numeric compare; a numeric identifier
 * is lower-precedence than an alphanumeric one; otherwise ASCII-lexical.
 */
function compareIdentifiers(a: number | string, b: number | string): number {
  const anum = numericRe.test(String(a));
  const bnum = numericRe.test(String(b));
  let av: number | string = a;
  let bv: number | string = b;
  if (anum && bnum) {
    av = +a;
    bv = +b;
  }
  if (av === bv) return 0;
  if (anum && !bnum) return -1;
  if (bnum && !anum) return 1;
  return av < bv ? -1 : 1;
}

/** A parsed semver, with a ConfigCat-precedence {@link SemVer.compare}. */
export class SemVer {
  readonly version: string;
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** Numberified pre-release identifiers (numeric ids become numbers). */
  readonly prerelease: ReadonlyArray<number | string>;
  /** Build-metadata identifiers (ignored for precedence). */
  readonly build: ReadonlyArray<string>;

  private constructor(
    version: string,
    major: number,
    minor: number,
    patch: number,
    prerelease: ReadonlyArray<number | string>,
    build: ReadonlyArray<string>,
  ) {
    this.version = version;
    this.major = major;
    this.minor = minor;
    this.patch = patch;
    this.prerelease = prerelease;
    this.build = build;
  }

  /**
   * Parse a version string under ConfigCat's strict grammar, returning
   * `null` on any failure (length, grammar, out-of-range core component) —
   * never throwing. Trims the input first (parse on trim).
   */
  static parse(version: string): SemVer | null {
    const trimmed = version.trim();
    if (trimmed.length > MAX_LENGTH) return null;
    const m = FULL.exec(trimmed);
    if (!m) return null;

    const major = +(m[1] as string);
    const minor = +(m[2] as string);
    const patch = +(m[3] as string);
    if (
      major > MAX_SAFE_INTEGER ||
      major < 0 ||
      minor > MAX_SAFE_INTEGER ||
      minor < 0 ||
      patch > MAX_SAFE_INTEGER ||
      patch < 0
    ) {
      return null;
    }

    // Numberify numeric pre-release ids (matching common-js).
    let prerelease: ReadonlyArray<number | string>;
    if (!m[4]) {
      prerelease = [];
    } else {
      prerelease = m[4].split(".").map((id): number | string => {
        if (numericRe.test(id)) {
          const num = +id;
          if (num >= 0 && num < MAX_SAFE_INTEGER) return num;
        }
        return id;
      });
    }

    const build: ReadonlyArray<string> = m[5] ? m[5].split(".") : [];

    let canonical = `${major}.${minor}.${patch}`;
    if (prerelease.length) canonical += `-${prerelease.join(".")}`;
    return new SemVer(canonical, major, minor, patch, prerelease, build);
  }

  /**
   * Compare against `other`: `<0` if this is lower-precedence, `0` if equal,
   * `>0` if higher. Build metadata is ignored. Mirrors common-js
   * `SemVer.compare` → `compareMain || comparePre`.
   */
  compare(other: SemVer): number {
    if (other.version === this.version) return 0;
    return this.compareMain(other) || this.comparePre(other);
  }

  private compareMain(other: SemVer): number {
    return (
      compareIdentifiers(this.major, other.major) ||
      compareIdentifiers(this.minor, other.minor) ||
      compareIdentifiers(this.patch, other.patch)
    );
  }

  private comparePre(other: SemVer): number {
    // A version WITHOUT a pre-release is higher-precedence than one WITH.
    if (this.prerelease.length && !other.prerelease.length) return -1;
    if (!this.prerelease.length && other.prerelease.length) return 1;
    if (!this.prerelease.length && !other.prerelease.length) return 0;

    let i = 0;
    for (;;) {
      const a = this.prerelease[i];
      const b = other.prerelease[i];
      if (a === undefined && b === undefined) return 0;
      if (b === undefined) return 1;
      if (a === undefined) return -1;
      if (a === b) {
        i++;
        continue;
      }
      return compareIdentifiers(a, b);
    }
  }
}

/**
 * Functional shorthand for {@link SemVer.parse}. Returns `null` on any
 * unparseable input (the caller surfaces this as a validation error —
 * research.md §R5 / FR-010 — never a silent match).
 */
export function parseSemVer(version: string): SemVer | null {
  return SemVer.parse(version);
}
